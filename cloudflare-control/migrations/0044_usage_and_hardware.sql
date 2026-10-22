-- Usage reports and the hardware each workstation runs on.
--
-- * client_devices.hardware: what the workstation's agent read once per start
--   (POST /api/devices/hardware): its manufacturer and model, CPU, memory,
--   boot mode, whether a keyboard and a touchscreen are attached, and its
--   wired adapters' MAC addresses for Wake-on-LAN. JSON validated by
--   parseHardwareReport in src/hardware.ts; hardware_at is when it arrived.
-- * tenants.usage_sites: 1 when the organization's usage reports record the
--   sites its workstations visit (the hostname only). On by default; an
--   administrator turns it off in Settings.
-- * usage_daily: per workstation and per day (the workstation's own calendar
--   day), seconds powered on, seconds in use, and fresh sessions
--   (POST /api/devices/usage, src/usage.ts).
-- * usage_sites: per organization and day, the hostnames visited, with the
--   seconds someone was using them and how many visits.
-- * platform_usage_daily, platform_usage_sites, hardware_models: what the
--   platform's administrators see. Built by the hourly cron from the tables
--   above with no organization in them, leaving out the platform's own demos;
--   a site appears only once three organizations visited it on a day.
--
-- Organization rows go with the organization (ON DELETE CASCADE) and after
-- USAGE_RETENTION_DAYS; the platform's anonymous totals stay.

ALTER TABLE client_devices ADD COLUMN hardware TEXT;
ALTER TABLE client_devices ADD COLUMN hardware_at INTEGER;

ALTER TABLE tenants ADD COLUMN usage_sites INTEGER NOT NULL DEFAULT 1
  CHECK (usage_sites IN (0, 1));

CREATE TABLE IF NOT EXISTS usage_daily (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  day TEXT NOT NULL,
  on_seconds INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, client_id, day)
);

CREATE TABLE IF NOT EXISTS usage_sites (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  domain TEXT NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, domain)
);

CREATE TABLE IF NOT EXISTS platform_usage_daily (
  day TEXT PRIMARY KEY,
  organizations INTEGER NOT NULL,
  workstations INTEGER NOT NULL,
  on_seconds INTEGER NOT NULL,
  active_seconds INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_usage_sites (
  day TEXT NOT NULL,
  domain TEXT NOT NULL,
  organizations INTEGER NOT NULL,
  active_seconds INTEGER NOT NULL,
  visits INTEGER NOT NULL,
  PRIMARY KEY (day, domain)
);

CREATE TABLE IF NOT EXISTS hardware_models (
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  organizations INTEGER NOT NULL,
  workstations INTEGER NOT NULL,
  uefi INTEGER NOT NULL,
  touch INTEGER NOT NULL,
  min_memory_mb INTEGER,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (vendor, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_tenant_day ON usage_daily(tenant_id, day);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);
CREATE INDEX IF NOT EXISTS idx_usage_sites_day ON usage_sites(day);
