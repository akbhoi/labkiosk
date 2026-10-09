-- What each release changed, for the /download page.
--
-- The hourly run reads the newest releases from GitHub and keeps them here:
-- the version, the date and the download addresses GitHub published, the
-- change list it wrote, and a summary of that list written for the people who
-- run workstations (src/release_notes.ts). The platform's own, like
-- ui_catalogs: no tenant_id.

CREATE TABLE IF NOT EXISTS release_notes (
  tag TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  url TEXT NOT NULL,
  iso_url TEXT,
  checksum_url TEXT,
  iso_bytes INTEGER,
  source_body TEXT NOT NULL DEFAULT '',
  summary TEXT,
  summary_model TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_notes_published ON release_notes(published_at);
