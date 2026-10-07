-- 0019: drop the columns Remote Control over Cloudflare Tunnel used.
--
-- Remote Control now runs through the console's own relay (src/remote_relay.ts),
-- so nothing reads or writes an organization's tunnel domain or the hostname a
-- workstation's tunnel answered on.
--
-- ALTER TABLE ... DROP COLUMN does not rebuild a table, so nothing here can
-- cascade (Rule 3b), and neither column is in an index or constraint.

ALTER TABLE tenants DROP COLUMN tunnel_domain;
ALTER TABLE client_devices DROP COLUMN remote_host;
