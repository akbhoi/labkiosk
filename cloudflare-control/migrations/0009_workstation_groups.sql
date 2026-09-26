-- Workstation Groups
--
-- Allows school admins to organize workstations into logical groups (e.g., Row 1,
-- Lab A, Team Blue) and filter the console or run targeted commands per group.

CREATE TABLE IF NOT EXISTS workstation_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workstation_groups_tenant ON workstation_groups(tenant_id);

ALTER TABLE client_devices ADD COLUMN group_name TEXT;
