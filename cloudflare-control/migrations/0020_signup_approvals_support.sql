-- Approval-gated signup, Remote Control approval, and the support inbox.
--
-- * tenants.remote_control_status: Remote Control is an add-on the platform
--   approves per organization. The platform's demos have it from the start.
-- * organization_profiles: what an organization told us at signup (contact,
--   address, billing) and when its email and phone were verified.
-- * email_codes: short-lived one-time codes sent by email (signup verification).
-- * conversations / conversation_messages: the super admin's Tasks (signups,
--   Remote Control requests) and Support (mail to the support address, the
--   contact form) with every message sent and received.
--
-- Additive only: no table is rebuilt, so nothing can cascade.

ALTER TABLE tenants ADD COLUMN remote_control_status TEXT NOT NULL DEFAULT 'none'
  CHECK (remote_control_status IN ('none', 'pending', 'approved', 'rejected'));

UPDATE tenants SET remote_control_status = 'approved'
  WHERE subdomain IN ('web-demo', 'local-demo', 'docker-demo');

CREATE TABLE IF NOT EXISTS organization_profiles (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name TEXT,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  email_verified_at INTEGER,
  phone_verified_at INTEGER,
  phone_verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  region TEXT,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL,
  tax_id TEXT,
  billing_email TEXT,
  workstation_estimate INTEGER,
  organization_type TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup')),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('signup', 'remote_control', 'support')),
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  reference TEXT UNIQUE NOT NULL,
  subject TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'closed')),
  unread INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note', 'event')),
  from_address TEXT,
  to_address TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  email_message_id TEXT,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  delivery TEXT CHECK (delivery IN ('sent', 'failed')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_codes_expires ON email_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_conversations_kind ON conversations(kind, status, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation ON conversation_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_email ON conversation_messages(email_message_id);
