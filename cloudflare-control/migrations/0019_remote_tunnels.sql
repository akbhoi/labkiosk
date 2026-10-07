-- Automatic Remote Control tunnels (src/remote_tunnels.ts).
--
-- remote_tunnel_accounts: one row per organization that turned automatic
-- tunnels on.
--
--   mode     own       in the organization's own Cloudflare account and domain;
--                      `api_token` is its API token, sealed with AES-GCM under
--                      the REMOTE_TUNNEL_KEY secret, never sent to a browser
--            platform  on the platform's remote-control domain (a separate
--                      zone, e.g. labkiosk.dev); `api_token` is NULL and the
--                      platform's own token is used
--
-- `access_policy_id` is the one reusable Access policy every workstation's
-- application uses, so changing who may connect is one update. Kept out of
-- `tenants` so no code that reads or returns an organization row can carry the
-- token along.
--
-- remote_tunnels: one row per workstation with a tunnel. The ids name what was
-- created in the Cloudflare account, so it can be deleted again; `token`
-- is the tunnel's run token, sealed the same way, handed only to that
-- workstation.
--
--   status   provisioning | active | failed
--
-- `hostname` is indexed: on the platform domain every organization shares one
-- zone, so an address another organization holds must be found and refused.
--
-- New tables with foreign keys to tenants: deleting an organization deletes
-- its rows. Nothing existing is rebuilt.

CREATE TABLE IF NOT EXISTS remote_tunnel_accounts (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('own', 'platform')),
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  api_token TEXT,
  access_rules TEXT NOT NULL,
  access_policy_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_tunnels (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  tunnel_id TEXT,
  dns_record_id TEXT,
  route_id TEXT,
  access_app_id TEXT,
  token TEXT,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'failed')),
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_remote_tunnels_hostname ON remote_tunnels(hostname);
