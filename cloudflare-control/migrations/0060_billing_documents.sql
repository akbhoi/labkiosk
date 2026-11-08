-- Billing documents: proforma invoices sent before a plan ends, and private
-- links to them and to tax invoices (src/billing_documents.ts).

-- A proforma invoice: what renewing will cost, with a payment link. It is not
-- a tax invoice, takes no invoice number and counts as no revenue; paying it
-- issues the tax invoice (src/billing.ts recordPayment).
CREATE TABLE IF NOT EXISTS proformas (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('renewal', 'cancelled', 'platform')),
  tier TEXT NOT NULL CHECK (tier IN ('starter', 'standard', 'pro', 'education')),
  period TEXT NOT NULL CHECK (period IN ('month', 'year')),
  extra_workstations INTEGER NOT NULL CHECK (extra_workstations >= 0),
  remote_seats INTEGER NOT NULL CHECK (remote_seats >= 0),
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
  covers_from INTEGER,
  covers_to INTEGER,
  valid_until INTEGER NOT NULL,
  payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired', 'void')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  emailed_at INTEGER,
  reminded_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_proformas_tenant ON proformas(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_proformas_payment ON proformas(payment_id);
CREATE INDEX IF NOT EXISTS idx_proformas_status ON proformas(status, valid_until);

-- A private link to one billing document, for someone without a console
-- session (the emailed copy). Only the token's SHA-256 is kept.
CREATE TABLE IF NOT EXISTS document_links (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'proforma')),
  document_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_links_document ON document_links(kind, document_id);
