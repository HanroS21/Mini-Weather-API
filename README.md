# Mini Weather — username/password migration

## What this version includes
- MySQL-backed username/password login.
- Password hashes stored with bcrypt; plaintext passwords are never stored.
- JWT authentication for dashboard APIs.
- First administrator automatically created from `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
- Admin-only user listing, creation, and deletion; optional email per account.
- Each user can change their own password.
- Existing saved-city and audit-log tables are preserved.
- Weather API key is used by the backend, not exposed in browser JavaScript.

## Setup
1. Back up your existing `mini_weather` database before running the migration.
2. Copy `.env.example` to `.env` and fill in database details, a strong `JWT_SECRET`, the initial admin username/password, and `OPENWEATHER_API_KEY`.
3. Use Node.js 18 or newer.
4. Run `npm install`.
5. Run `npm start`.
6. Serve `index.html`, `script.js`, and `style.css` using a local web server (for example, VS Code Live Server). The frontend defaults to `http://localhost:5000` for the API.

## Existing users
The migration preserves old user rows and their saved cities. Existing email-code accounts receive a `legacy_<id>` username if they did not have one. They cannot log in with a password until an administrator creates a replacement account for them; no password is guessed or generated. Consider reviewing old rows and backups before production use.

## Security notes
- Do not commit `.env` to source control.
- Use HTTPS in production and set `FRONTEND_ORIGIN` to your exact frontend origin(s).
- `ADMIN_PASSWORD` is only used to create the initial admin when that username does not exist. Changing it in `.env` later does not reset the account password; use the in-app password-change form.
- Admin user deletion removes that user's saved cities through the existing foreign key, but the audit history remains.
- The current activity page shows the signed-in user's own audit entries. The `/api/users` endpoint is administrator-only.
- Use a production-grade rate limiter and security headers before exposing the API publicly.
