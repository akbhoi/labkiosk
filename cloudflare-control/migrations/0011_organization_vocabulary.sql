-- Organization vocabulary
--
-- Lab Kiosk is no longer only for school computer labs, so the stored names
-- move with the product: role 'school_admin' -> 'org_admin', 'teacher' ->
-- 'operator', 'lab_assistant' -> 'assistant', and the staff permission
-- 'teachers' -> 'staff'. Rows still holding the old default lock message get
-- the new neutral one.
--
-- The roles are CHECK constraints, which SQLite cannot alter, so users and
-- tenant_users have to be rebuilt. That is only safe done this way:
--
--   * D1 cannot switch foreign keys off, and DROP TABLE deletes the table's rows
--     first, which fires ON DELETE CASCADE even with defer_foreign_keys on.
--     Rebuilding users in place cascade-deleted every tenant and session when
--     this was tried. So every table that references users -- directly, or
--     through tenants -- is rebuilt with it.
--   * Every row is copied into a holding table with no foreign keys first, the
--     old tables are dropped leaves-first (nothing is ever dropped while a table
--     that cascades from it still exists), recreated parents-first, and filled
--     back with explicit column lists: production columns are not in the
--     SCHEMA_SQL order, because later migrations appended them.
--   * Wrangler applies this file as one unit; if any statement fails, nothing
--     has changed.
--
-- idx_tenants_custom_domain is recreated UNIQUE, as 0003 made it.
--
-- Before applying this in production: wrangler d1 export labkiosk-db --remote --output backup.sql

PRAGMA defer_foreign_keys = true;

-- 1. Hold every row.
CREATE TABLE _hold_users AS SELECT * FROM users;
CREATE TABLE _hold_tenants AS SELECT * FROM tenants;
CREATE TABLE _hold_sessions AS SELECT * FROM sessions;
CREATE TABLE _hold_portal_sites AS SELECT * FROM portal_sites;
CREATE TABLE _hold_client_devices AS SELECT * FROM client_devices;
CREATE TABLE _hold_commands AS SELECT * FROM commands;
CREATE TABLE _hold_audit_logs AS SELECT * FROM audit_logs;
CREATE TABLE _hold_device_tokens AS SELECT * FROM device_tokens;
CREATE TABLE _hold_tenant_whitelist AS SELECT * FROM tenant_whitelist;
CREATE TABLE _hold_broadcast_presets AS SELECT * FROM broadcast_presets;
CREATE TABLE _hold_tenant_users AS SELECT * FROM tenant_users;
CREATE TABLE _hold_workstation_groups AS SELECT * FROM workstation_groups;

-- 2. Drop leaves first, so no drop can cascade into a table that still exists.
DROP TABLE workstation_groups;
DROP TABLE tenant_users;
DROP TABLE broadcast_presets;
DROP TABLE tenant_whitelist;
DROP TABLE device_tokens;
DROP TABLE audit_logs;
DROP TABLE commands;
DROP TABLE client_devices;
DROP TABLE portal_sites;
DROP TABLE sessions;
DROP TABLE tenants;
DROP TABLE users;

-- 3. Recreate, parents first.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'org_admin')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE NOT NULL,
  requested_subdomain TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'rejected', 'suspended')),
  mode TEXT NOT NULL DEFAULT 'portal' CHECK (mode IN ('portal', 'single_url')),
  default_url TEXT NOT NULL DEFAULT 'https://www.khanacademy.org',
  admin_pin TEXT NOT NULL DEFAULT '1234',
  enrollment_key TEXT NOT NULL DEFAULT '',
  custom_domain TEXT UNIQUE,
  requested_custom_domain TEXT,
  custom_domain_status TEXT NOT NULL DEFAULT 'none',
  default_lock_message TEXT NOT NULL DEFAULT 'This screen has been locked by an administrator. Please wait.',
  portal_title TEXT,
  portal_subtitle TEXT,
  portal_description TEXT,
  portal_footer TEXT,
  broadcast_url TEXT,
  broadcast_epoch INTEGER NOT NULL DEFAULT 0,
  home_route TEXT DEFAULT '/',
  tunnel_domain TEXT,
  homepage_headline TEXT,
  homepage_intro TEXT,
  homepage_blocks TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE portal_sites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  icon TEXT,
  thumbnail_url TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE client_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_num INTEGER NOT NULL DEFAULT 1,
  ip TEXT,
  last_seen INTEGER NOT NULL,
  is_locked INTEGER NOT NULL DEFAULT 0,
  active_url TEXT,
  thumbnail TEXT,
  vnc_password TEXT,
  remote_host TEXT,
  group_name TEXT,
  broadcast_url TEXT,
  broadcast_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tenant_whitelist (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, domain)
);

CREATE TABLE broadcast_presets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('org_admin', 'sub_admin', 'operator', 'assistant', 'content_manager')),
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE workstation_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 4. Indexes.
CREATE INDEX idx_tenants_subdomain ON tenants(subdomain);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE UNIQUE INDEX idx_tenants_custom_domain ON tenants(custom_domain);
CREATE INDEX idx_tenants_custom_domain_status ON tenants(custom_domain_status);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_portal_sites_tenant ON portal_sites(tenant_id, order_index);
CREATE INDEX idx_client_devices_tenant ON client_devices(tenant_id);
CREATE INDEX idx_commands_tenant_target ON commands(tenant_id, target, expires_at);
CREATE INDEX idx_device_tokens_tenant ON device_tokens(tenant_id, client_id);
CREATE INDEX idx_tenant_whitelist_tenant ON tenant_whitelist(tenant_id);
CREATE INDEX idx_audit_logs_tenant ON audit_logs(tenant_id, created_at);
CREATE INDEX idx_broadcast_presets_tenant ON broadcast_presets(tenant_id);
CREATE INDEX idx_tenant_users_tenant ON tenant_users(tenant_id);
CREATE INDEX idx_tenant_users_user ON tenant_users(user_id);
CREATE INDEX idx_workstation_groups_tenant ON workstation_groups(tenant_id);

-- 5. Copy back, parents first, renaming the stored values.
INSERT INTO users (id, email, password_hash, salt, role, name, created_at)
  SELECT id, email, password_hash, salt, CASE role WHEN 'school_admin' THEN 'org_admin' WHEN 'teacher' THEN 'operator' WHEN 'lab_assistant' THEN 'assistant' ELSE role END, name, created_at
  FROM _hold_users;
INSERT INTO tenants (id, user_id, name, subdomain, requested_subdomain, status, mode, default_url, admin_pin, enrollment_key, custom_domain, requested_custom_domain, custom_domain_status, default_lock_message, portal_title, portal_subtitle, portal_description, portal_footer, broadcast_url, broadcast_epoch, home_route, tunnel_domain, homepage_headline, homepage_intro, homepage_blocks, created_at, updated_at)
  SELECT id, user_id, name, subdomain, requested_subdomain, status, mode, default_url, admin_pin, enrollment_key, custom_domain, requested_custom_domain, custom_domain_status, CASE default_lock_message WHEN 'Screens locked by the instructor. Please look to the front.' THEN 'This screen has been locked by an administrator. Please wait.' ELSE default_lock_message END, portal_title, portal_subtitle, portal_description, portal_footer, broadcast_url, broadcast_epoch, home_route, tunnel_domain, homepage_headline, homepage_intro, homepage_blocks, created_at, updated_at
  FROM _hold_tenants;
INSERT INTO sessions (token, user_id, tenant_id, role, expires_at)
  SELECT token, user_id, tenant_id, CASE role WHEN 'school_admin' THEN 'org_admin' WHEN 'teacher' THEN 'operator' WHEN 'lab_assistant' THEN 'assistant' ELSE role END, expires_at
  FROM _hold_sessions;
INSERT INTO portal_sites (id, tenant_id, title, url, domain, category, icon, thumbnail_url, order_index, is_active, created_at)
  SELECT id, tenant_id, title, url, domain, category, icon, thumbnail_url, order_index, is_active, created_at
  FROM _hold_portal_sites;
INSERT INTO client_devices (id, tenant_id, client_id, client_num, ip, last_seen, is_locked, active_url, thumbnail, vnc_password, remote_host, group_name, broadcast_url, broadcast_epoch, created_at, updated_at)
  SELECT id, tenant_id, client_id, client_num, ip, last_seen, is_locked, active_url, thumbnail, vnc_password, remote_host, group_name, broadcast_url, broadcast_epoch, created_at, updated_at
  FROM _hold_client_devices;
INSERT INTO commands (id, tenant_id, target, action, payload_json, created_at, expires_at)
  SELECT id, tenant_id, target, action, payload_json, created_at, expires_at
  FROM _hold_commands;
INSERT INTO audit_logs (id, tenant_id, user_id, action, details, created_at)
  SELECT id, tenant_id, user_id, action, details, created_at
  FROM _hold_audit_logs;
INSERT INTO device_tokens (id, token_hash, tenant_id, client_id, created_at, last_used_at, revoked)
  SELECT id, token_hash, tenant_id, client_id, created_at, last_used_at, revoked
  FROM _hold_device_tokens;
INSERT INTO tenant_whitelist (id, tenant_id, domain, created_at)
  SELECT id, tenant_id, domain, created_at
  FROM _hold_tenant_whitelist;
INSERT INTO broadcast_presets (id, tenant_id, title, url, created_at)
  SELECT id, tenant_id, title, url, created_at
  FROM _hold_broadcast_presets;
INSERT INTO tenant_users (id, tenant_id, user_id, role, permissions, created_at)
  SELECT id, tenant_id, user_id, CASE role WHEN 'school_admin' THEN 'org_admin' WHEN 'teacher' THEN 'operator' WHEN 'lab_assistant' THEN 'assistant' ELSE role END, REPLACE(permissions, '"teachers"', '"staff"'), created_at
  FROM _hold_tenant_users;
INSERT INTO workstation_groups (id, tenant_id, name, created_at)
  SELECT id, tenant_id, name, created_at
  FROM _hold_workstation_groups;

-- 6. Release the holding tables.
DROP TABLE _hold_workstation_groups;
DROP TABLE _hold_tenant_users;
DROP TABLE _hold_broadcast_presets;
DROP TABLE _hold_tenant_whitelist;
DROP TABLE _hold_device_tokens;
DROP TABLE _hold_audit_logs;
DROP TABLE _hold_commands;
DROP TABLE _hold_client_devices;
DROP TABLE _hold_portal_sites;
DROP TABLE _hold_sessions;
DROP TABLE _hold_tenants;
DROP TABLE _hold_users;
