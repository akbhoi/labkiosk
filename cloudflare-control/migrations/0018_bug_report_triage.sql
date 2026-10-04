-- Bug report triage (src/bug_reports.ts).
--
-- Which version of the Automatic Bug Report Terms an organization accepted,
-- and when. Reports are sent only while the accepted version is the current one.
ALTER TABLE tenants ADD COLUMN bug_reports_terms_version TEXT;
ALTER TABLE tenants ADD COLUMN bug_reports_terms_accepted_at INTEGER;

-- What a reasoning model compares a new problem with, and where each GitHub
-- issue stands. One issue may have several signatures (rows); status is kept
-- the same on all of them.
ALTER TABLE bug_reports ADD COLUMN title TEXT;
ALTER TABLE bug_reports ADD COLUMN problem TEXT;
ALTER TABLE bug_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'in_progress', 'pr_open', 'resolved', 'closed'));
ALTER TABLE bug_reports ADD COLUMN pr_url TEXT;
ALTER TABLE bug_reports ADD COLUMN status_checked_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_bug_reports_issue ON bug_reports(issue_number);

-- Whether a sent problem opened a new issue or was matched to an existing one.
ALTER TABLE workstation_issues ADD COLUMN report_match TEXT CHECK (report_match IN ('new', 'existing'));
