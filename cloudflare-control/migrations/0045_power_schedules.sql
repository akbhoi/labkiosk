-- Power schedules: when an organization's workstations switch themselves off,
-- and on again (Settings -> Power, src/power.ts).
--
-- One row per schedule. days is a bitmask of the days it applies on, bit 0
-- Sunday to bit 6 Saturday (JavaScript's getDay()); off_minute and on_minute are
-- minutes after midnight on the workstation's own clock (no time zone, as in
-- the usage reports); on_minute is NULL when the workstations are switched on
-- by hand. group_id is NULL for every workstation, else one workstation group:
-- for each day a workstation follows its group's schedule for that day when
-- there is one, otherwise the all-workstations one. Two schedules for the same
-- workstations never share a day (checked by the route).
--
-- A group's schedules go with the group, and every schedule with its
-- organization (ON DELETE CASCADE): a later cascade-safe rebuild of tenants or
-- workstation_groups holds this table too.

CREATE TABLE IF NOT EXISTS power_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES workstation_groups(id) ON DELETE CASCADE,
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 127),
  off_minute INTEGER NOT NULL CHECK (off_minute BETWEEN 0 AND 1439),
  on_minute INTEGER CHECK (on_minute IS NULL OR on_minute BETWEEN 0 AND 1439),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_power_schedules_tenant ON power_schedules(tenant_id);
