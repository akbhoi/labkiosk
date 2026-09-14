-- Lab Kiosk: device enrolment, per-school allowlists, command delivery receipts
--
-- Adds the tables behind three fixes:
--   1. /api/telemetry now requires a per-device bearer token, issued by
--      exchanging the school's enrollment key. Previously anyone who guessed a
--      subdomain could post screenshots and drain that school's command queue.
--   2. The domain allowlist moves out of a mutable module-global in the worker
--      (shared by every tenant and lost on isolate recycle) into per-tenant rows.
--   3. Broadcast commands record a delivery receipt per workstation, so each
--      client executes one exactly once instead of on every 3s heartbeat.

ALTER TABLE tenants ADD COLUMN enrollment_key TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  -- SHA-256 of the issued token; the token itself is never stored.
  token_hash TEXT UNIQUE NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tenant_whitelist (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, domain)
);

CREATE TABLE IF NOT EXISTS command_deliveries (
  command_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (command_id, client_id)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  identifier TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_failed_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_tenant ON device_tokens(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_tenant_whitelist_tenant ON tenant_whitelist(tenant_id);
CREATE INDEX IF NOT EXISTS idx_command_deliveries_client ON command_deliveries(client_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id, created_at);

-- Existing schools have an empty enrollment_key, which cannot authenticate any
-- device (the worker rejects a zero-length key outright). Each school must
-- generate one from Settings -> Workstation Enrollment Key before enrolling.
