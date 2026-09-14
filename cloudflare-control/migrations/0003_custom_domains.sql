-- Lab Kiosk: Custom Domain support for schools and universities
--
-- Adds custom domain fields to the tenants table:
--   * custom_domain: Approved FQDN (e.g. kiosk.myschool.edu)
--   * requested_custom_domain: Pending custom domain requested by the school admin
--   * custom_domain_status: 'none', 'pending', 'approved', or 'rejected'

ALTER TABLE tenants ADD COLUMN custom_domain TEXT;
ALTER TABLE tenants ADD COLUMN requested_custom_domain TEXT;
ALTER TABLE tenants ADD COLUMN custom_domain_status TEXT NOT NULL DEFAULT 'none';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_custom_domain ON tenants(custom_domain);
CREATE INDEX IF NOT EXISTS idx_tenants_custom_domain_status ON tenants(custom_domain_status);

