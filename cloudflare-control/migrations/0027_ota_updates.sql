-- Over-the-air updates, phase 3 (docs/OTA_UPDATES.md section 5.7).
--
-- * releases: the signed system images CI uploaded to the releases bucket, as a
--   super admin found them there. A release reaches no workstation until it is
--   classified `beta` or `stable`; a revoked one reaches none again. The
--   platform's own, like ui_catalogs: no tenant_id. The manifest is kept as
--   CI wrote it; the Worker trusts nothing in it, because every workstation
--   checks its signature before it downloads a byte.
-- * tenants.update_channel: which classified releases the organization's
--   workstations are offered.
-- * client_devices.update_phase / update_version / update_progress /
--   update_detail / agent_version: what the workstation last said about the
--   update it is fetching or holding (live, idle, downloading, ready,
--   installing, up-to-date, error), written back by OrgHub. Separate from
--   update_state (0015), which is the outcome of its last boot.

CREATE TABLE IF NOT EXISTS releases (
  version TEXT PRIMARY KEY,
  channel TEXT CHECK (channel IN ('beta', 'stable')),
  kind TEXT NOT NULL CHECK (kind IN ('feature', 'security')),
  base_version TEXT,
  security_floor TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  manifest TEXT NOT NULL,
  found_at INTEGER NOT NULL,
  classified_at INTEGER,
  classified_by TEXT,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_releases_channel ON releases(channel);

ALTER TABLE tenants ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable'
  CHECK (update_channel IN ('stable', 'beta'));

ALTER TABLE client_devices ADD COLUMN update_phase TEXT;
ALTER TABLE client_devices ADD COLUMN update_version TEXT;
ALTER TABLE client_devices ADD COLUMN update_progress INTEGER;
ALTER TABLE client_devices ADD COLUMN update_detail TEXT;
ALTER TABLE client_devices ADD COLUMN agent_version TEXT;
