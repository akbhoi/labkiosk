-- Over-the-air updates, phase 4 (docs/OTA_UPDATES.md sections 5.5 and 7).
--
-- * tenants.security_updates: what the organization's workstations do with a
--   security release for the line they run: give it its one try at their next
--   boot without anyone's approval (`next_boot`), or wait for an administrator
--   like any other release (`approval`).
-- * client_devices.update_kind / update_since: the kind of the release the
--   workstation holds (feature or security), and since when it has held it
--   ready or staged in this boot, written back by OrgHub with the other update
--   fields, so the console can say "not restarted in N days".

ALTER TABLE tenants ADD COLUMN security_updates TEXT NOT NULL DEFAULT 'next_boot'
  CHECK (security_updates IN ('next_boot', 'approval'));

ALTER TABLE client_devices ADD COLUMN update_kind TEXT;
ALTER TABLE client_devices ADD COLUMN update_since INTEGER;
