-- Who accepted which version of which legal document, and when each version
-- was first published.
--
-- * legal_acceptances: append-only. One row per document an organization's
--   administrator accepted (at registration, or in the console when a version
--   changes), with the organization's name and the user's email as they were,
--   the address and browser it came from. Deliberately no foreign keys: the
--   record outlives the organization and the user, and nothing updates or
--   deletes it.
-- * legal_versions: when the Worker first served a document version. An
--   organization that has not accepted the current version is asked to from
--   then on, and its console asks before anything else once the notice period
--   (30 days) has passed.

CREATE TABLE IF NOT EXISTS legal_acceptances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  document TEXT NOT NULL CHECK (document IN ('terms', 'privacy', 'aup', 'content')),
  version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('registration', 'console')),
  accepted_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_tenant ON legal_acceptances(tenant_id, document, version);

CREATE TABLE IF NOT EXISTS legal_versions (
  document TEXT NOT NULL CHECK (document IN ('terms', 'privacy', 'aup', 'content')),
  version TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  notified_at INTEGER,
  PRIMARY KEY (document, version)
);
