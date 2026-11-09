-- An organization changes its own console address, at most once a week, with no
-- approval. Every address it gave up keeps reaching it, because each workstation
-- keeps the address it enrolled with; nobody else can take one.
ALTER TABLE tenants ADD COLUMN address_changed_at INTEGER;

CREATE TABLE IF NOT EXISTS retired_addresses (
  subdomain TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  retired_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retired_addresses_tenant ON retired_addresses(tenant_id);
