-- Passkeys as a sign-in factor.
--
-- * user_passkeys: one row per passkey an account registered. id is the
--   credential id (base64url); rp_id the relying party it was made for (the
--   platform domain, or a custom domain); public_key its JWK; algorithm the
--   COSE algorithm (-7 ES256, -257 RS256); sign_count the authenticator's
--   counter, which must move forward when it is not 0.
-- * passkey_registrations: the challenge of a registration in progress, one
--   per account, purged hourly once expired.
-- * login_challenges.passkey_challenge: the WebAuthn challenge a sign-in's
--   second step asked a passkey to sign.
--
-- Additive only: new tables and a new column, nothing rebuilt.

CREATE TABLE IF NOT EXISTS user_passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rp_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  algorithm INTEGER NOT NULL CHECK (algorithm IN (-7, -257)),
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS passkey_registrations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

ALTER TABLE login_challenges ADD COLUMN passkey_challenge TEXT;

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id, rp_id);
