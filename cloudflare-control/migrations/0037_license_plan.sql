-- The license an organization runs under, as the platform recorded it.
--
-- * tenants.license_plan: which grant of LICENSE applies -- 'education' (an
--   accredited educational institution), 'evaluation' (non-commercial evaluation,
--   up to 45 computers), 'subscriber' or 'commercial'. NULL: not recorded yet.
-- * tenants.license_expires_at: Unix seconds the license ends; NULL: no end date.
--   Once it has passed, the organization enrols no new workstation and opens no
--   Remote Control session. Enrolled workstations keep working, and its console
--   says why.

ALTER TABLE tenants ADD COLUMN license_plan TEXT
  CHECK (license_plan IS NULL OR license_plan IN ('education', 'evaluation', 'subscriber', 'commercial'));
ALTER TABLE tenants ADD COLUMN license_expires_at INTEGER;
