-- 0031: the log of a workstation's boot that ended without shutting down.
--
-- An installed workstation keeps its system journal on LABKIOSK_DATA for seven
-- days. When a boot ends without a shutdown (a power cut, a hang the hardware
-- watchdog reset, a kernel panic), the next boot sends the last lines of that
-- boot's journal with POST /api/devices/restart-report. They are listed in
-- Settings -> Errors & Warnings like any other issue, as kind
-- unexpected_restart or watchdog_reset, with the log beside them.
--
--   log_text   the end of that boot's journal, at most 16 KiB; NULL for every
--              other issue. The hourly cron clears it after
--              RESTART_LOG_RETENTION_DAYS; the row itself stays for the usual
--              WORKSTATION_ISSUE_RETENTION_DAYS.
--
-- Never part of an automatic bug report: bug_reports.ts reads only the
-- one-line details.

ALTER TABLE workstation_issues ADD COLUMN log_text TEXT;
