-- Controls over what organizations publish on the pages the platform hosts.
--
-- * link_blocklist: domains no organization homepage link or User Portal card
--   may point to (a domain blocks its subdomains too). A platform table.
-- * tenants.homepage_takedown_at / homepage_takedown_reason: a super admin took
--   the organization homepage down, after a report; it shows a neutral notice
--   until restored.
-- * portal_sites.takedown_at / takedown_reason: a User Portal card a super admin
--   took down. It is also made inactive (is_active = 0), so no portal shows it.

CREATE TABLE IF NOT EXISTS link_blocklist (
  domain TEXT PRIMARY KEY,
  reason TEXT,
  added_at INTEGER NOT NULL,
  added_by TEXT
);

ALTER TABLE tenants ADD COLUMN homepage_takedown_at INTEGER;
ALTER TABLE tenants ADD COLUMN homepage_takedown_reason TEXT;
ALTER TABLE portal_sites ADD COLUMN takedown_at INTEGER;
ALTER TABLE portal_sites ADD COLUMN takedown_reason TEXT;
