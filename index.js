require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { initDb, getPool, withTransaction } = require("./db");

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.JWT_EXPIRES_IN || "8h";

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("Set JWT_SECRET in .env to a random secret of at least 32 characters.");
}

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

console.log("Allowed origins:", allowedOrigins);

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (for example, curl or server-to-server calls).
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    console.warn("Blocked origin:", origin);
    callback(null, false);
  }
}));
app.use(express.json({ limit: "20kb" }));
app.use((req, _res, next) => { req.body ??= {}; next(); });

const nowSql = () => new Date();
const accountLabel = (user) => user.email || user.username;

function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL, issuer: "mini-weather" }
  );
}

async function audit(conn, actor, action, entity, entityId, details = {}) {
  await conn.query(
    `INSERT INTO audit_log (at, user_id, user_email, action, entity, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      nowSql(),
      actor?.id ?? null,
      actor ? accountLabel(actor) : "system",
      action,
      entity,
      entityId ?? null,
      JSON.stringify(details)
    ]
  );
}

async function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ message: "Sign in is required." });

  try {
    const payload = jwt.verify(match[1], JWT_SECRET, { issuer: "mini-weather" });
    const [rows] = await getPool().query(
      "SELECT id, username, email, role FROM users WHERE id = ?",
      [payload.uid]
    );
    if (!rows.length) return res.status(401).json({ message: "This account no longer exists." });
    req.user = rows[0]; // Role is loaded from the database, not trusted from the token.
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError" || err.name === "NotBeforeError") {
      return res.status(401).json({ message: "Your session is invalid or has expired. Sign in again." });
    }
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ message: "Administrator access is required." });
  next();
}

function validUsername(username) {
  return typeof username === "string" && /^[a-zA-Z0-9_.-]{3,50}$/.test(username.trim());
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 200;
}
function validEmail(email) {
  return email == null || email === "" ||
    (typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

app.get("/", (_req, res) => res.json({ name: "Mini Weather API", status: "ok" }));

/* ---------- Authentication ---------- */

// Username/password login.
app.post("/auth/login", async (req, res, next) => {
  try {
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!username || !password) return res.status(400).json({ message: "Enter your username and password." });

    const [rows] = await getPool().query(
      "SELECT id, username, email, password_hash, role FROM users WHERE username = ?",
      [username]
    );
    const user = rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: "Incorrect username or password." });
    }

    await getPool().query("UPDATE users SET last_login_at = ? WHERE id = ?", [nowSql(), user.id]);
    res.json({
      access_token: signToken(user),
      user: { id: user.id, username: user.username, email: user.email, role: user.role }
    });
  } catch (err) { next(err); }
});

app.get("/auth/me", requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, email: req.user.email, role: req.user.role });
});

// Public: tells the sign-up page whether the next account will be the administrator.
app.get("/auth/setup-status", async (_req, res, next) => {
  try {
    const [rows] = await getPool().query("SELECT COUNT(*) AS total FROM users");
    res.json({ needsSetup: Number(rows[0].total) === 0 });
  } catch (err) { next(err); }
});

// Public sign-up. The first account becomes the administrator; every later one is a normal user.
app.post("/auth/signup", async (req, res, next) => {
  try {
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const email = typeof req.body.email === "string" && req.body.email.trim()
      ? req.body.email.trim().toLowerCase()
      : null;

    if (!validUsername(username)) {
      return res.status(400).json({ message: "Username must be 3–50 characters using letters, numbers, dots, underscores or hyphens." });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ message: "Password must be at least 12 characters." });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ message: "Enter a valid email address or leave it blank." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const created = await withTransaction(async (conn) => {
      const [existing] = await conn.query("SELECT id FROM users LIMIT 1 FOR UPDATE");
      const role = existing.length === 0 ? "admin" : "user";

      const [result] = await conn.query(
        "INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
        [username, email, passwordHash, role, nowSql()]
      );
      const user = { id: result.insertId, username, email, role };
      await audit(conn, user, "CREATE", "user", user.id, {
        username,
        email,
        role,
        source: role === "admin" ? "first_account_setup" : "self_signup"
      });
      return user;
    });

    res.status(201).json({
      message: created.role === "admin"
        ? "Administrator account created. Sign in with your username and password."
        : "Account created. Sign in with your username and password.",
      role: created.role
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "That username or email is already in use." });
    }
    next(err);
  }
});

app.post("/auth/change-password", requireAuth, async (req, res, next) => {
  try {
    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;
    if (!validPassword(newPassword)) {
      return res.status(400).json({ message: "New password must be at least 12 characters." });
    }
    const [rows] = await getPool().query("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
    if (!rows[0]?.password_hash || !(await bcrypt.compare(String(currentPassword || ""), rows[0].password_hash))) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await withTransaction(async (conn) => {
      await conn.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, req.user.id]);
      await audit(conn, req.user, "UPDATE", "user", req.user.id, { change: "password" });
    });
    res.json({ message: "Password changed. Sign in again with your new password." });
  } catch (err) { next(err); }
});

/* ---------- Admin: users ---------- */

app.get("/api/users", requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const [rows] = await getPool().query(
      "SELECT id, username, email, role, created_at, last_login_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const email = typeof req.body.email === "string" && req.body.email.trim() ? req.body.email.trim().toLowerCase() : null;
    const password = req.body.password;
    const role = req.body.role === "admin" ? "admin" : "user";

    if (!validUsername(username)) return res.status(400).json({ message: "Username must be 3–50 characters using letters, numbers, dots, underscores or hyphens." });
    if (!validPassword(password)) return res.status(400).json({ message: "Password must be at least 12 characters." });
    if (!validEmail(email)) return res.status(400).json({ message: "Enter a valid email address or leave it blank." });

    const passwordHash = await bcrypt.hash(password, 12);
    const newUser = await withTransaction(async (conn) => {
      const [result] = await conn.query(
        "INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
        [username, email, passwordHash, role, nowSql()]
      );
      const created = { id: result.insertId, username, email, role };
      await audit(conn, req.user, "CREATE", "user", created.id, { username, email, role });
      return created;
    });
    res.status(201).json(newUser);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "That username or email is already in use." });
    next(err);
  }
});

app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: "Invalid user ID." });
    if (id === req.user.id) return res.status(400).json({ message: "You cannot delete your own administrator account." });

    await withTransaction(async (conn) => {
      const [rows] = await conn.query("SELECT id, username, email, role FROM users WHERE id = ? FOR UPDATE", [id]);
      if (!rows.length) {
        const err = new Error("User not found."); err.status = 404; throw err;
      }
      if (rows[0].role === "admin") {
        const [admins] = await conn.query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'");
        if (Number(admins[0].total) <= 1) {
          const err = new Error("You cannot delete the last administrator."); err.status = 400; throw err;
        }
      }
      await audit(conn, req.user, "DELETE", "user", id, { username: rows[0].username, role: rows[0].role });
      await conn.query("DELETE FROM users WHERE id = ?", [id]);
    });
    res.json({ message: "User deleted." });
  } catch (err) { next(err); }
});

/* ---------- Saved cities (each account sees only its own) ---------- */
app.get("/api/cities", requireAuth, async (req, res, next) => {
  try {
    const [rows] = await getPool().query(
      "SELECT id, city, note, created_at, updated_at FROM saved_cities WHERE user_id = ? ORDER BY city",
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post("/api/cities", requireAuth, async (req, res, next) => {
  try {
    const city = typeof req.body.city === "string" ? req.body.city.trim() : "";
    if (!city || city.length > 100) return res.status(400).json({ message: "City must be between 1 and 100 characters." });
    const at = nowSql();
    await withTransaction(async (conn) => {
      const [result] = await conn.query(
        "INSERT INTO saved_cities (user_id, city, note, created_at, updated_at) VALUES (?, ?, '', ?, ?)",
        [req.user.id, city, at, at]
      );
      await audit(conn, req.user, "CREATE", "saved_city", result.insertId, { city, note: "" });
    });
    res.status(201).json({ message: "City saved." });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "That city is already saved." });
    next(err);
  }
});

app.put("/api/cities/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const note = typeof req.body.note === "string" ? req.body.note.trim() : null;
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: "Invalid city ID." });
    if (note === null || note.length > 200) return res.status(400).json({ message: "Note must be 0–200 characters." });

    await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        "SELECT id, city, note FROM saved_cities WHERE id = ? AND user_id = ? FOR UPDATE",
        [id, req.user.id]
      );
      if (!rows.length) { const err = new Error("Saved city not found."); err.status = 404; throw err; }
      await conn.query("UPDATE saved_cities SET note = ?, updated_at = ? WHERE id = ?", [note, nowSql(), id]);
      await audit(conn, req.user, "UPDATE", "saved_city", id, {
        city: rows[0].city,
        changes: { note: { from: rows[0].note, to: note } }
      });
    });
    res.json({ message: "Note updated." });
  } catch (err) { next(err); }
});

app.delete("/api/cities/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: "Invalid city ID." });
    await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        "SELECT id, city, note FROM saved_cities WHERE id = ? AND user_id = ? FOR UPDATE",
        [id, req.user.id]
      );
      if (!rows.length) { const err = new Error("Saved city not found."); err.status = 404; throw err; }
      await conn.query("DELETE FROM saved_cities WHERE id = ?", [id]);
      await audit(conn, req.user, "DELETE", "saved_city", id, { city: rows[0].city, note: rows[0].note });
    });
    res.json({ message: "City deleted." });
  } catch (err) { next(err); }
});

/* ---------- Activity log ---------- */
const AUDIT_SELECT = `SELECT id, at, user_id, user_email, action, entity, entity_id, details
                        FROM audit_log`;

app.get("/api/audit", requireAuth, async (req, res, next) => {
  try {
    // Administrators see everyone's activity. Normal users see only their own.
    const [rows] = req.user.role === "admin"
      ? await getPool().query(`${AUDIT_SELECT} ORDER BY id DESC LIMIT 200`)
      : await getPool().query(`${AUDIT_SELECT} WHERE user_id = ? ORDER BY id DESC LIMIT 200`, [req.user.id]);

    res.json(rows.map((row) => ({
      ...row,
      details: typeof row.details === "string" ? JSON.parse(row.details) : (row.details || {})
    })));
  } catch (err) { next(err); }
});

/* ---------- Weather proxy (keeps the API key on the server) ---------- */

app.get("/api/weather", requireAuth, async (req, res, next) => {
  try {
    const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
    if (!city || city.length > 100) return res.status(400).json({ message: "Enter a valid city name." });
    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) return res.status(503).json({ message: "Weather service is not configured. Set OPENWEATHER_API_KEY in .env." });

    const url = new URL("https://api.openweathermap.org/data/2.5/weather");
    url.searchParams.set("q", city);
    url.searchParams.set("units", "metric");
    url.searchParams.set("appid", key);
    const upstream = await fetch(url);
    const data = await upstream.json().catch(() => ({}));
    if (upstream.status === 404) return res.status(404).json({ message: `Couldn't find "${city}". Check the spelling.` });
    if (!upstream.ok) return res.status(upstream.status === 401 ? 502 : upstream.status).json({
      message: upstream.status === 401 ? "The server's weather API key is invalid." : (data.message || "Weather service request failed.")
    });
    res.json(data);
  } catch (err) { next(err); }
});

// Final error handler. Don't expose SQL details to the browser.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    message: err.status ? err.message : "An unexpected server error occurred."
  });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Mini Weather API listening on port ${PORT}`)))
  .catch((err) => {
    console.error("Startup failed:", err.message);
    process.exit(1);
  });