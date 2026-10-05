-- 0016: errors and warnings workstations report, kept apart from the audit log.
--
-- The audit log records what people did to an organization. A workstation whose
-- new system image failed its first boot, or that rolled back to the old one,
-- is a different thing: something to look into. These rows feed Settings ->
-- Errors & Warnings and are deleted after WORKSTATION_ISSUE_RETENTION_DAYS by
-- the hourly cron.
--
--   severity      error | warning
--   kind          update_failed | update_rolled_back | boot_fallback | boot_error
--   occurred_at   when the workstation recorded it (its own clock, seconds)
--   created_at    when the Worker received it
--
-- A new table with a foreign key to tenants: deleting an organization deletes
-- its issues, as it does its workstations. Nothing existing is rebuilt.

CREATE TABLE IF NOT EXISTS workstation_issues (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
  kind TEXT NOT NULL,
  image_version TEXT,
  details TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workstation_issues_tenant ON workstation_issues(tenant_id, created_at);
