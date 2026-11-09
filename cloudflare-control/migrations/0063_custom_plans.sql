-- Custom plans are the one thing the platform still decides by hand. An
-- organization asks for one from Plan & billing; a super admin sets its terms
-- and price, which sends a payment link; paying it applies the plan.
CREATE TABLE IF NOT EXISTS custom_plan_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  workstations INTEGER NOT NULL CHECK (workstations > 0),
  remote_seats INTEGER NOT NULL DEFAULT 0 CHECK (remote_seats >= 0),
  staff INTEGER CHECK (staff IS NULL OR staff > 0),
  period TEXT NOT NULL CHECK (period IN ('month', 'year')),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'paid', 'declined')),
  subtotal_paise INTEGER,
  gst_paise INTEGER,
  total_paise INTEGER,
  payment_id TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER,
  decision_note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_custom_plan_requests_tenant ON custom_plan_requests(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_custom_plan_requests_status ON custom_plan_requests(status);
CREATE INDEX IF NOT EXISTS idx_custom_plan_requests_payment ON custom_plan_requests(payment_id);
