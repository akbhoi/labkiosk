-- Single sign-on for organization staff with Google Workspace or Microsoft
-- Entra ID (OpenID Connect), src/sso.ts.
--
-- * sso_settings: one row per organization that configured it. Which
--   providers are on, the Google Workspace domains (JSON list) and Entra
--   tenant ids (JSON list) an account must belong to, and require_sso: staff
--   other than the owner may not sign in with a password while a provider is
--   on and offered. No row = single sign-on is off.
-- * sso_states: one row per sign-in in flight. state_hash is the SHA-256 of
--   the `state` sent to the provider; code_verifier (PKCE) and nonce go with
--   it; redirect_uri is the callback the provider was given and return_origin
--   the sign-in page the browser started on; browser_hash binds the row to a
--   cookie set on that page. The callback spends the state (used_at), then
--   records the matched account (user_id) and the SHA-256 of a one-time code
--   (handoff_hash) the sign-in page redeems within two minutes. Purged hourly
--   once expired.
--
-- Additive only: new tables, nothing rebuilt.

CREATE TABLE IF NOT EXISTS sso_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  google_enabled INTEGER NOT NULL DEFAULT 0 CHECK (google_enabled IN (0, 1)),
  google_domains TEXT NOT NULL DEFAULT '[]',
  microsoft_enabled INTEGER NOT NULL DEFAULT 0 CHECK (microsoft_enabled IN (0, 1)),
  microsoft_tenants TEXT NOT NULL DEFAULT '[]',
  require_sso INTEGER NOT NULL DEFAULT 0 CHECK (require_sso IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sso_states (
  state_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  return_origin TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  used_at INTEGER,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  handoff_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sso_states_expires ON sso_states(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_states_handoff ON sso_states(handoff_hash);
