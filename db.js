// MySQL connection and safe, repeatable schema setup.
const mysql = require("mysql2/promise");

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || ""
};
const dbName = process.env.DB_NAME || "mini_weather";

if (!/^\w+$/.test(dbName)) {
  throw new Error("DB_NAME may only contain letters, numbers and underscores.");
}

let pool;

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return Number(rows[0].count) > 0;
}

async function initDb() {
  const admin = await mysql.createConnection(config);
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4`);
  await admin.end();

  pool = mysql.createPool({
    ...config,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z"
  });

  // Create the new schema. The ALTER steps below also migrate existing installations.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NULL,
      email VARCHAR(254) NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      role ENUM('admin','user') NOT NULL DEFAULT 'user',
      created_at DATETIME(3) NOT NULL,
      last_login_at DATETIME(3) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  if (!(await columnExists("users", "username"))) {
    await pool.query("ALTER TABLE users ADD COLUMN username VARCHAR(50) NULL");
  }
  if (!(await columnExists("users", "password_hash"))) {
    await pool.query("ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL");
  }
  if (!(await columnExists("users", "role"))) {
    await pool.query("ALTER TABLE users ADD COLUMN role ENUM('admin','user') NOT NULL DEFAULT 'user'");
  }

  // Existing email-code accounts are preserved, including their saved cities.
  // They receive a unique placeholder username and must be recreated/reset by an admin
  // before they can log in with a password. No password is invented for old accounts.
  await pool.query("UPDATE users SET username = CONCAT('legacy_', id) WHERE username IS NULL OR username = ''");
  await pool.query("ALTER TABLE users MODIFY COLUMN username VARCHAR(50) NOT NULL");
  await pool.query("ALTER TABLE users MODIFY COLUMN email VARCHAR(254) NULL");
  await pool.query("ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL");
  await pool.query("ALTER TABLE users ADD UNIQUE KEY uq_users_username (username)")
    .catch((err) => { if (err.code !== "ER_DUP_KEYNAME") throw err; });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_cities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      city VARCHAR(100) NOT NULL,
      note VARCHAR(200) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_user_city (user_id, city),
      CONSTRAINT fk_city_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // No FK on purpose: audit history survives deletion of an account.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      at DATETIME(3) NOT NULL,
      user_id INT NULL,
      user_email VARCHAR(254) NOT NULL,
      action VARCHAR(10) NOT NULL,
      entity VARCHAR(30) NOT NULL,
      entity_id INT NULL,
      details JSON NULL,
      KEY idx_audit_user (user_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log(`Database ready: ${dbName} on ${config.host}:${config.port}`);
}

const getPool = () => {
  if (!pool) throw new Error("Database has not been initialized.");
  return pool;
};

async function withTransaction(work) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { initDb, getPool, withTransaction };
