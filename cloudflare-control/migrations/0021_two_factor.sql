-- Two-factor sign-in and sign-in alerts.
--
-- * user_two_factor: an account's authenticator-app secret (TOTP), when it was
--   turned on (NULL while being set up), the last 30-second step used (a code
--   works once), and its recovery codes as a JSON list of SHA-256 hashes.
-- * login_challenges: a sign-in whose password checked out, waiting for its
--   second factor; keyed by the SHA-256 of the token the browser holds, with
--   the hash of an emailed code when one was asked for. Purged hourly.
-- * user_devices: the browsers an account has signed in from (the SHA-256 of
--   an HttpOnly cookie), for the new-browser alert and "trust this browser".
--
-- Additive only: new tables, nothing rebuilt.

CREATE TABLE IF NOT EXISTS user_two_factor (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret TEXT NOT NULL,
  enabled_at INTEGER,
  last_totp_step INTEGER NOT NULL DEFAULT 0,
  recovery_codes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  redirect TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  email_code_hash TEXT,
  email_codes_sent INTEGER NOT NULL DEFAULT 0,
  email_code_sent_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_devices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  trusted_until INTEGER,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_login_challenges_expires ON login_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_challenges_user ON login_challenges(user_id);
