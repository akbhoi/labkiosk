-- Sessions stored under the SHA-256 of their token (src/db.ts, sessionKey), so
-- a copy of the database holds no token a browser could present. Rows already
-- here keep the token itself with hashed = 0; the hourly job and each row's
-- next use rewrite them, so nobody is signed out.

ALTER TABLE sessions ADD COLUMN hashed INTEGER NOT NULL DEFAULT 0 CHECK (hashed IN (0, 1));
