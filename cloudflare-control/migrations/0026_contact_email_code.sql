-- The contact form proves its sender's address with an emailed code, as
-- registration does (src/signup.ts). email_codes.purpose is a CHECK, and SQLite
-- cannot alter one, so the table is rebuilt with 'contact' allowed.
--
-- Nothing refers to email_codes and a row lives ten minutes, so it is dropped
-- rather than copied: a code sent in the minutes before this runs has to be
-- asked for again.

DROP TABLE email_codes;

CREATE TABLE email_codes (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'contact')),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_codes_expires ON email_codes(expires_at);
