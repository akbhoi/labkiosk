-- 0014: live workstation state moves to each organization's Durable Object.
--
-- Every workstation heartbeat used to rewrite its `client_devices` row with a
-- fresh screenshot and read the command queue from D1, every 3 seconds. That
-- traffic now lives in the organization's OrgHub Durable Object (src/org_hub.ts):
--
--   * The command queue and its delivery receipts are in each OrgHub's own
--     SQLite, so `commands` and `command_deliveries` go. Queued commands expire
--     after 60 seconds anyway, so nothing of value is dropped.
--   * Screenshots are relayed from a workstation to the consoles watching it and
--     never stored, so `client_devices.thumbnail` goes.
--   * The super-admin directory reads the number of workstations online from
--     `tenants.online_workstations`, which OrgHub updates when the count changes.
--   * Custom domains are provisioned through Cloudflare for SaaS; the custom
--     hostname's id and its certificate status are kept on the organization.
--
-- None of these tables is referenced by a foreign key, and ALTER TABLE ... ADD
-- or DROP COLUMN does not rebuild a table, so nothing here can cascade (Rule 3b).

DROP INDEX IF EXISTS idx_command_deliveries_client;
DROP INDEX IF EXISTS idx_commands_tenant_target;
DROP TABLE IF EXISTS command_deliveries;
DROP TABLE IF EXISTS commands;

ALTER TABLE client_devices DROP COLUMN thumbnail;

ALTER TABLE tenants ADD COLUMN online_workstations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN custom_hostname_id TEXT;
ALTER TABLE tenants ADD COLUMN custom_hostname_status TEXT NOT NULL DEFAULT 'none';
