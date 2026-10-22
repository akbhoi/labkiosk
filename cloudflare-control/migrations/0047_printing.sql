-- Printing on the workstations, off until an administrator turns it on.
--
-- * tenants.printing_enabled: 1 when the organization's workstations may print
--   (Settings -> Printing). 0 for every organization, existing ones included:
--   with it off a workstation runs no print service and Chromium refuses to print.
-- * printers: the organization's network printers, by display name and IPP
--   address (ipp:// or ipps://, checked by printerUriProblem in src/printing.ts),
--   each for every workstation (group_name NULL) or for one workstation group,
--   matched by name like client_devices.group_name. id (16 hex digits) is also
--   the queue name on the workstation (labkiosk-<id>); position is the order
--   the console lists them in. A rebuild of tenants must hold this table too.

ALTER TABLE tenants ADD COLUMN printing_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (printing_enabled IN (0, 1));

CREATE TABLE IF NOT EXISTS printers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  uri TEXT NOT NULL,
  group_name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_printers_tenant ON printers(tenant_id, position);
