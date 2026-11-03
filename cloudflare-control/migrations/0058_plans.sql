-- Plans: Free, a one-time trial, paid subscriptions, verified education, and
-- workstations beyond the plan's limit (src/plans.ts, src/education.ts, src/billing.ts).

-- When the organization started its one free trial.
ALTER TABLE tenants ADD COLUMN trial_started_at INTEGER;

-- An active organization with no plan recorded ran under the old free grant up
-- to its workstation limit. It keeps that as a Custom plan with no end date
-- until the platform records another; NULL now means the Free plan.
UPDATE tenants SET license_plan = 'commercial' WHERE license_plan IS NULL AND status = 'active';

-- Enrolled workstations the plan's limit does not cover: their kiosk shows a
-- notice until a licence is free for them.
CREATE TABLE IF NOT EXISTS unlicensed_workstations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, client_id)
);

-- A school's application for the free Education plan. The emailed code proves
-- an address on the school's own domain; the certificate is in R2 under
-- certificate_key; the platform approves or rejects it by hand.
CREATE TABLE IF NOT EXISTS education_applications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  institution TEXT NOT NULL,
  board TEXT NOT NULL,
  affiliation_number TEXT NOT NULL,
  website TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT,
  code_expires_at INTEGER,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  email_verified_at INTEGER,
  certificate_key TEXT,
  certificate_name TEXT NOT NULL,
  certificate_type TEXT NOT NULL,
  certificate_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'verifying'
  CHECK (status IN ('verifying', 'pending', 'approved', 'rejected')),
  decision_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_education_applications_tenant ON education_applications(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_education_applications_status ON education_applications(status, submitted_at);

-- A subscription payment through a Razorpay Payment Link. id is the link's
-- reference_id; amounts are paise.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id TEXT UNIQUE,
  short_url TEXT,
  period TEXT NOT NULL CHECK (period IN ('month', 'year')),
  extra_workstations INTEGER NOT NULL CHECK (extra_workstations >= 0),
  subtotal_paise INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
  razorpay_payment_id TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  period_ends_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id, created_at);
