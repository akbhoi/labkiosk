-- The public status page (src/status.ts): each check's latest result, checks
-- and failures per component per day, and the incidents the super admin posts.

CREATE TABLE IF NOT EXISTS status_latest (
  component TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail TEXT,
  checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_daily (
  component TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (component, day)
);

CREATE TABLE IF NOT EXISTS status_incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('minor', 'major')),
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS status_incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_incidents_created ON status_incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_status_incident_updates_incident ON status_incident_updates(incident_id, created_at);
