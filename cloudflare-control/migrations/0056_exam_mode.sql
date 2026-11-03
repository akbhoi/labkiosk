-- Exam mode (src/exams.ts): a timed window in which an organization's
-- workstations, or one group of them, show only the exam site, cannot print,
-- and have their sessions cleared at the start and the end. Each workstation's
-- connections and disconnections during the window are kept for the report.

CREATE TABLE IF NOT EXISTS exam_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  group_name TEXT,
  exam_url TEXT NOT NULL,
  allowed_hosts TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  ended_at INTEGER,
  finalized_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  ended_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS exam_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('start-online', 'start-offline', 'connect', 'disconnect')),
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exam_sessions_tenant ON exam_sessions(tenant_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_exam_events_exam ON exam_events(exam_id, client_id, at);
