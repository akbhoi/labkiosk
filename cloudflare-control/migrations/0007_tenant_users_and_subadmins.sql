-- Lab Kiosk: Sub-admins, teacher delegation, configurable home route and tunnel domain

CREATE TABLE IF NOT EXISTS tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'teacher' CHECK (role IN ('school_admin', 'sub_admin', 'teacher', 'lab_assistant', 'content_manager')),
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user ON tenant_users(user_id);

ALTER TABLE tenants ADD COLUMN home_route TEXT DEFAULT '/';
ALTER TABLE tenants ADD COLUMN tunnel_domain TEXT;
