-- Notifications the platform shows in organization consoles.
--
-- * notifications: one message from the platform. tenant_id is the organization
--   it is for, or NULL for every organization (a release line reaching end of
--   life, a message to all customers). An organization registered after a
--   message to every organization does not see it.
-- * notification_reads: who has dismissed which notification. A console shows
--   the notifications its user has not dismissed.
-- * release_lines.eol_reminder_days: the last end-of-life reminder sent for the
--   line's end_of_life_at (60, 30 or 7 days before, 0 once it has passed); NULL
--   when none has been sent for the current date.

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('general', 'account', 'release', 'legal', 'license', 'content', 'remote_control')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

ALTER TABLE release_lines ADD COLUMN eol_reminder_days INTEGER;
