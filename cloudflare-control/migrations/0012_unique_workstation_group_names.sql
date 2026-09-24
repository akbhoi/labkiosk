-- Migration 0012: one workstation group per name, per organization.
--
-- Membership is stored by name (client_devices.group_name), so two groups
-- sharing a name share members, and deleting either ungroups both. The API has
-- refused a duplicate since the groups shipped, but only by reading the list
-- first: two requests at once could both pass that check. The database now
-- enforces it, compared case-insensitively like the API.
--
-- Any duplicates that already exist are folded into the oldest group of that
-- name before the index is built, and member devices are re-pointed at that
-- group's spelling so none of them is left in a group that no longer exists.

UPDATE client_devices
SET group_name = (
  SELECT g.name FROM workstation_groups g
  WHERE g.tenant_id = client_devices.tenant_id
    AND g.name = client_devices.group_name COLLATE NOCASE
  ORDER BY g.created_at, g.id
  LIMIT 1
)
WHERE group_name IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM workstation_groups g
    WHERE g.tenant_id = client_devices.tenant_id
      AND g.name = client_devices.group_name COLLATE NOCASE
  );

DELETE FROM workstation_groups
WHERE EXISTS (
  SELECT 1 FROM workstation_groups keep
  WHERE keep.tenant_id = workstation_groups.tenant_id
    AND keep.name = workstation_groups.name COLLATE NOCASE
    AND (keep.created_at < workstation_groups.created_at
         OR (keep.created_at = workstation_groups.created_at AND keep.id < workstation_groups.id))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workstation_groups_tenant_name
  ON workstation_groups(tenant_id, name COLLATE NOCASE);
