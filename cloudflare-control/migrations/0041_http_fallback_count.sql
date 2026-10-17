-- How many of an organization's online workstations are on the HTTP heartbeat
-- (an agent without the WebSocket client, or one whose network drops WebSocket
-- upgrades) instead of the WebSocket control channel.
--
-- Every HTTP heartbeat is a billed Worker request that also wakes the
-- organization's hub, while a WebSocket workstation costs almost nothing when
-- idle. OrgHub keeps this beside online_workstations so the Super Admin list
-- shows which organizations are on the expensive path without a query per
-- organization.

ALTER TABLE tenants ADD COLUMN http_workstations INTEGER NOT NULL DEFAULT 0;
