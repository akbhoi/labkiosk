-- A custom domain is included in Custom and Pro, and an add-on on Starter,
-- Standard and Education (Rs 299 a month, Rs 2,990 a year). These record what
-- each subscription, payment and proforma sells, and whether the organization
-- pays for the add-on now.
ALTER TABLE tenants ADD COLUMN custom_domain_paid INTEGER NOT NULL DEFAULT 0 CHECK (custom_domain_paid IN (0, 1));
ALTER TABLE subscriptions ADD COLUMN custom_domain INTEGER NOT NULL DEFAULT 0 CHECK (custom_domain IN (0, 1));
ALTER TABLE payments ADD COLUMN custom_domain INTEGER NOT NULL DEFAULT 0 CHECK (custom_domain IN (0, 1));
ALTER TABLE proformas ADD COLUMN custom_domain INTEGER NOT NULL DEFAULT 0 CHECK (custom_domain IN (0, 1));
