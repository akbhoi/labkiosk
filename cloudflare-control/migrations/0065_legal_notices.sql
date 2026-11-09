-- Every customer is emailed when any legal document changes, accepted or not.
--
-- * legal_versions also records the Refund & Cancellation Policy, which
--   organizations are told about but neither accept nor acknowledge. Nothing
--   references legal_versions, so it is rebuilt in place to widen its CHECK.
-- * legal_notices: which organization was emailed about which version, so the
--   hourly run emails each one once and carries on where it stopped.

CREATE TABLE legal_versions_next (
  document TEXT NOT NULL CHECK (document IN ('terms', 'privacy', 'aup', 'content', 'refunds')),
  version TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  notified_at INTEGER,
  PRIMARY KEY (document, version)
);
INSERT INTO legal_versions_next (document, version, published_at, notified_at)
  SELECT document, version, published_at, notified_at FROM legal_versions;
DROP TABLE legal_versions;
ALTER TABLE legal_versions_next RENAME TO legal_versions;

CREATE TABLE IF NOT EXISTS legal_notices (
  document TEXT NOT NULL,
  version TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sent_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  PRIMARY KEY (document, version, tenant_id)
);
