-- Console addresses (src/addresses.ts). A registration now gets a generated
-- address (address_generated = 1); a chosen one, which also turns on the public
-- homepage, is granted on request and kept beside it in chosen_subdomain, so the
-- address workstations enrolled with never changes. Organizations registered
-- before this keep the address they chose (address_generated = 0).
-- feature_tip_dismissed_at: when the console's tip about Remote Control and a
-- chosen address was last dismissed; it comes back after 30 days.

ALTER TABLE tenants ADD COLUMN address_generated INTEGER NOT NULL DEFAULT 0 CHECK (address_generated IN (0, 1));
ALTER TABLE tenants ADD COLUMN chosen_subdomain TEXT;
ALTER TABLE tenants ADD COLUMN feature_tip_dismissed_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_chosen_subdomain ON tenants(chosen_subdomain);
