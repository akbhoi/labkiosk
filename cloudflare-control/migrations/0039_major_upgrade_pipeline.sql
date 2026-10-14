-- The pipeline an organization's workstations take to a new major release.
--
-- * requested_by / requested_at: an administrator of the organization asked
--   Lab Kiosk for a closed major. A super admin grants or declines the request.
-- * pilot_group / pilot_by / pilot_at: before confirming a major for every
--   workstation, an administrator tries it on one workstation group first; only
--   workstations in that group are offered it until the major is confirmed.

ALTER TABLE major_upgrade_grants ADD COLUMN requested_by TEXT;
ALTER TABLE major_upgrade_grants ADD COLUMN requested_at INTEGER;
ALTER TABLE major_upgrade_grants ADD COLUMN pilot_group TEXT;
ALTER TABLE major_upgrade_grants ADD COLUMN pilot_by TEXT;
ALTER TABLE major_upgrade_grants ADD COLUMN pilot_at INTEGER;
