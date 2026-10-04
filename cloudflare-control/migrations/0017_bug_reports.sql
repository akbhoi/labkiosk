-- Automatic bug reports: an organization that opts in has its workstations'
-- errors and warnings filed, redacted, as GitHub issues (src/bug_reports.ts).
-- Off by default.
ALTER TABLE tenants ADD COLUMN bug_reports_enabled INTEGER NOT NULL DEFAULT 0;

-- 'pending' when the issue was recorded while its organization had opted in,
-- 'sent' once it has a GitHub issue (its own or an earlier one with the same
-- signature), 'none' otherwise.
ALTER TABLE workstation_issues ADD COLUMN report_state TEXT NOT NULL DEFAULT 'none'
  CHECK (report_state IN ('none', 'pending', 'sent'));
ALTER TABLE workstation_issues ADD COLUMN bug_signature TEXT;

-- One GitHub issue per distinct redacted error, shared by every organization
-- that reports it. Holds no organization or workstation data.
CREATE TABLE IF NOT EXISTS bug_reports (
  signature TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  image_version TEXT,
  issue_number INTEGER NOT NULL,
  issue_url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
