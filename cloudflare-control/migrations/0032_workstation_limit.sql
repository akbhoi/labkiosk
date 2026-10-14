-- How many workstations an organization may enrol, set by a super admin.
--
-- * tenants.workstation_limit: enrolment refuses a new workstation once this
--   many hold a valid device token. 45 by default, the most the LabKiosk
--   Software License allows without a paid licence. A workstation already
--   enrolled is never cut off when the limit is lowered.
--
-- An organization that already has more workstations than that keeps them:
-- its limit starts at the number it has.

ALTER TABLE tenants ADD COLUMN workstation_limit INTEGER NOT NULL DEFAULT 45
  CHECK (workstation_limit BETWEEN 1 AND 100000);

UPDATE tenants SET workstation_limit = (
  SELECT COUNT(DISTINCT d.client_id) FROM device_tokens d WHERE d.tenant_id = tenants.id AND d.revoked = 0
)
WHERE (
  SELECT COUNT(DISTINCT d.client_id) FROM device_tokens d WHERE d.tenant_id = tenants.id AND d.revoked = 0
) > 45;
