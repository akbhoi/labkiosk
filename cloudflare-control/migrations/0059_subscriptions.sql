-- Subscriptions: tiers, automatic renewal through Razorpay Subscriptions, a
-- per-workstation Remote Control add-on, staff caps and GST invoices
-- (src/plans.ts, src/subscriptions.ts, src/invoices.ts).

-- The tier an organization pays for, and what it buys. license_plan,
-- license_expires_at and workstation_limit stay what everything else enforces.
ALTER TABLE tenants ADD COLUMN plan_tier TEXT
  CHECK (plan_tier IS NULL OR plan_tier IN ('starter', 'standard', 'pro'));
ALTER TABLE tenants ADD COLUMN staff_limit INTEGER;
ALTER TABLE tenants ADD COLUMN remote_seats_paid INTEGER NOT NULL DEFAULT 0 CHECK (remote_seats_paid >= 0);
-- When a halted subscription's organization falls to Free.
ALTER TABLE tenants ADD COLUMN grace_ends_at INTEGER;
-- Who the invoices are made out to.
ALTER TABLE tenants ADD COLUMN billing_legal_name TEXT;
ALTER TABLE tenants ADD COLUMN billing_gstin TEXT;
ALTER TABLE tenants ADD COLUMN billing_address TEXT;
ALTER TABLE tenants ADD COLUMN billing_state TEXT;

-- Today's subscribers bought the one plan there was: it is Standard now.
UPDATE tenants SET plan_tier = 'standard' WHERE license_plan = 'subscriber';

-- Organizations already approved for Remote Control keep their seats until
-- their next subscription says otherwise; a seat goes to the first
-- workstations they open.
UPDATE tenants SET remote_seats_paid = remote_control_seats WHERE remote_control_status = 'approved';

-- Staff over the plan's cap after a downgrade: kept, but unable to sign in.
ALTER TABLE tenant_users ADD COLUMN suspended_at INTEGER;

-- One row per Razorpay subscription Lab Kiosk created. Amounts are paise,
-- worked out when it was sold and never again.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('starter', 'standard', 'pro', 'education')),
  period TEXT NOT NULL CHECK (period IN ('month', 'year')),
  catalogue_version INTEGER NOT NULL,
  extra_workstations INTEGER NOT NULL CHECK (extra_workstations >= 0),
  remote_seats INTEGER NOT NULL CHECK (remote_seats >= 0),
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise > 0),
  gst_paise INTEGER NOT NULL CHECK (gst_paise >= 0),
  total_paise INTEGER NOT NULL CHECK (total_paise > 0),
  -- A replacement bought mid-term charges the pro-rated difference once, when
  -- it is authorised (Razorpay's upfront add-on), GST included.
  upfront_paise INTEGER NOT NULL DEFAULT 0 CHECK (upfront_paise >= 0),
  upfront_gst_paise INTEGER NOT NULL DEFAULT 0 CHECK (upfront_gst_paise >= 0),
  razorpay_plan_id TEXT,
  razorpay_subscription_id TEXT UNIQUE,
  short_url TEXT,
  status TEXT NOT NULL DEFAULT 'created'
  CHECK (status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'paused', 'expired')),
  current_start INTEGER,
  current_end INTEGER,
  -- Set when the organization cancelled: it keeps what it paid for until current_end.
  cancelled_at INTEGER,
  cancel_reason TEXT,
  -- A replacement starts when the subscription it replaces ends.
  replaces_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  starts_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status, current_end);

-- Every verified Razorpay webhook, once.
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  entity_id TEXT,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  outcome TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_billing_events_tenant ON billing_events(tenant_id, received_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_entity ON billing_events(entity_id, received_at);

-- A tax invoice (or, before the seller has a GSTIN, a receipt) for every
-- captured charge. The figures are copied from what was sold, never recomputed.
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('subscription', 'payment')),
  source_id TEXT NOT NULL,
  razorpay_payment_id TEXT NOT NULL UNIQUE,
  subtotal_paise INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL,
  sgst_paise INTEGER NOT NULL,
  igst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  seller_gstin TEXT,
  buyer_name TEXT NOT NULL,
  buyer_gstin TEXT,
  buyer_address TEXT,
  place_of_supply TEXT,
  lines_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, issued_at);

-- Gap-free invoice numbers per Indian financial year ("2026-27").
CREATE TABLE IF NOT EXISTS invoice_counters (
  fy TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);

-- Workstations that carry one of the organization's Remote Control seats.
CREATE TABLE IF NOT EXISTS remote_control_workstations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, client_id)
);

-- One-off charges now also pay for a mid-term upgrade, or are sent by the
-- platform to an organization; each says which.
ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy'
  CHECK (kind IN ('legacy', 'proration', 'platform_link'));
ALTER TABLE payments ADD COLUMN tier TEXT
  CHECK (tier IS NULL OR tier IN ('starter', 'standard', 'pro', 'education'));
ALTER TABLE payments ADD COLUMN remote_seats INTEGER NOT NULL DEFAULT 0 CHECK (remote_seats >= 0);
ALTER TABLE payments ADD COLUMN subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN sent_to TEXT;
ALTER TABLE payments ADD COLUMN note TEXT;
ALTER TABLE payments ADD COLUMN expires_at INTEGER;
