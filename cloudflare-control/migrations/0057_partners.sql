-- Certified hardware and the reseller directory on /hardware (src/partners.ts).

CREATE TABLE IF NOT EXISTS certified_hardware (
  vendor_key TEXT NOT NULL,
  model_key TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  note TEXT,
  certified_at INTEGER NOT NULL,
  certified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (vendor_key, model_key)
);

CREATE TABLE IF NOT EXISTS resellers (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  state TEXT NOT NULL,
  city TEXT NOT NULL,
  website TEXT,
  stocks TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_resellers_status ON resellers(status, state, city);
CREATE INDEX IF NOT EXISTS idx_resellers_email ON resellers(email);
