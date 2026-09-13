-- Lab Kiosk Multi-Tenant SaaS Initial Schema
-- Supports Super Admin, School Tenant Admins, Subdomains, Student App Cards, and Client Telemetry

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'school_admin')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE NOT NULL,
  requested_subdomain TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'rejected', 'suspended')),
  mode TEXT NOT NULL DEFAULT 'portal' CHECK (mode IN ('portal', 'single_url')),
  default_url TEXT NOT NULL DEFAULT 'https://www.khanacademy.org',
  admin_pin TEXT NOT NULL DEFAULT '1234',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_sites (
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

CREATE TABLE IF NOT EXISTS client_devices (
  id TEXT PRIMARY KEY, -- Composite: tenant_id:client_id
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_num INTEGER NOT NULL DEFAULT 1,
  ip TEXT,
  last_seen INTEGER NOT NULL,
  is_locked INTEGER NOT NULL DEFAULT 0,
  active_url TEXT,
  thumbnail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);

-- Indices for rapid lookup
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_portal_sites_tenant ON portal_sites(tenant_id, order_index);
CREATE INDEX IF NOT EXISTS idx_client_devices_tenant ON client_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_commands_tenant_target ON commands(tenant_id, target, expires_at);
