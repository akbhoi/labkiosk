-- Lab Kiosk: interface translation catalogs, served to workstations
--
-- A workstation ships with English and can display any other language for which
-- it has a catalog. Until now the only way to deliver one was to copy a file
-- onto the data partition of every machine by hand, which is not something a
-- school with forty workstations will do.
--
-- These rows are PLATFORM assets, not tenant data: the wizard and the kiosk bar
-- are the same product text for every school, so there is no tenant_id to scope
-- by here. Only a super admin writes them (POST /api/super/i18n), and they are
-- readable without a session (GET /i18n/<tag>.json) because a workstation
-- fetches its interface language before it is enrolled and holds no credential
-- at that point. Nothing tenant-specific may be stored in them.

CREATE TABLE IF NOT EXISTS ui_catalogs (
  tag TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'ltr',
  body TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_ui_catalogs_updated ON ui_catalogs(updated_at);
