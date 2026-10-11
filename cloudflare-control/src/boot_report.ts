/**
 * Boot reports: what an installed workstation's last boot did with its system image.
 *
 * `labkiosk-boot-slots check` (root, on the workstation) writes the outcome to
 * /run/labkiosk-update/status.json; the agent sends it here with
 * POST /api/devices/boot-report. The latest outcome is kept on the
 * workstation's `client_devices` row. A failure, a rollback, a fallback or an
 * error is also kept in `workstation_issues`, so an administrator sees it in
 * Settings -> Errors & Warnings without touching the machine. The audit log
 * stays a record of what people did.
 */
import { sha256Hex } from "./auth";
import { WorkstationIssue } from "./types";

/** The outcomes worth an administrator's attention; routine boots are not reported. */
export const BOOT_REPORT_STATES = ["installed", "failed", "rolled-back", "fallback", "error"] as const;
export type BootReportState = (typeof BOOT_REPORT_STATES)[number];

/** The same release version labkiosk-boot-slots accepts (VERSION_PATTERN). */
const VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
const MAX_ERROR_LENGTH = 300;
/** A report from further back than this is stale, not news. */
const MAX_REPORT_AGE_SECONDS = 7 * 86400;
/** Workstation clocks drift; a report this far ahead of ours is still accepted. */
const MAX_CLOCK_AHEAD_SECONDS = 300;
/**
 * Reports from one workstation at least this far apart. A boot reports once,
 * and boots are minutes apart, so a real workstation never meets this limit;
 * one replaying invented reports cannot flood Errors & Warnings.
 */
export const BOOT_REPORT_MIN_GAP_SECONDS = 60;

export interface BootReport {
  state: BootReportState;
  version: string;
  /** The image a trial boot replaced (`installed`, `failed`). */
  previous: string | null;
  /** The image that failed its one try (`rolled-back`). */
  failed: string | null;
  error: string | null;
  at: number;
}

/** How each outcome is listed in Errors & Warnings; an installed update is not an issue. */
const ISSUES: Partial<Record<BootReportState, { severity: "error" | "warning"; kind: string }>> = {
  failed: { severity: "error", kind: "update_failed" },
  "rolled-back": { severity: "error", kind: "update_rolled_back" },
  error: { severity: "error", kind: "boot_error" },
  fallback: { severity: "warning", kind: "boot_fallback" }
};

/** Issues older than this are deleted by the hourly cron. */
export const WORKSTATION_ISSUE_RETENTION_DAYS = 90;
const MAX_ISSUES_LISTED = 200;

function optionalVersion(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`${field} is not a release version`);
  }
  return value;
}

/** Validate a report from a workstation; throws with the reason on anything malformed. */
export function parseBootReport(input: unknown, now: number): BootReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The boot report must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  const state = body.state;
  if (typeof state !== "string" || !(BOOT_REPORT_STATES as readonly string[]).includes(state)) {
    throw new Error("state is not a reportable boot outcome");
  }
  const version = body.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error("version is not a release version");
  }
  const at = body.at;
  if (typeof at !== "number" || !Number.isInteger(at)) {
    throw new Error("at must be a whole number of seconds");
  }
  if (at > now + MAX_CLOCK_AHEAD_SECONDS || at < now - MAX_REPORT_AGE_SECONDS) {
    throw new Error("at is outside the accepted window");
  }
  let error: string | null = null;
  if (body.error !== undefined && body.error !== null && body.error !== "") {
    if (typeof body.error !== "string") throw new Error("error must be text");
    // Control characters would garble the console's table; the text itself is
    // only ever rendered with textContent.
    error = body.error.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_ERROR_LENGTH) || null;
  }
  return {
    state: state as BootReportState,
    version,
    previous: optionalVersion(body.previous, "previous"),
    failed: optionalVersion(body.failed, "failed"),
    error,
    at
  };
}

/** One line an administrator can act on, for the Errors & Warnings list. */
export function describeBootReport(report: BootReport): string {
  switch (report.state) {
    case "failed":
      return `${report.version} failed its health check on its first boot; restarting into ${report.previous || "the previous image"}.`;
    case "rolled-back":
      return `${report.failed || "A new image"} failed its first boot; back on ${report.version}.`;
    case "fallback":
      return `Started ${report.version} because the image it should have started is missing or damaged.`;
    case "error":
      return report.error || "The boot record could not be read or written.";
    default:
      return `Running ${report.version}.`;
  }
}

export type BootReportOutcome = "recorded" | "duplicate" | "unknown-workstation";

/**
 * Keep the report on the workstation's row and, when it is an issue, list it, once.
 *
 * The row is updated only by a report at least BOOT_REPORT_MIN_GAP_SECONDS
 * newer than the one it holds, so the agent re-sending after a lost reply, or
 * after a restart in the same boot, writes nothing twice. A workstation whose
 * row the organization's hub has not written yet is told so and tries again.
 */
export async function recordBootReport(
  db: D1Database,
  tenantId: string,
  clientId: string,
  report: BootReport,
  now: number
): Promise<BootReportOutcome> {
  const result = await db
    .prepare(
      `UPDATE client_devices
          SET image_version = ?, update_state = ?, update_error = ?, update_state_at = ?, updated_at = ?
        WHERE tenant_id = ? AND client_id = ? AND update_state_at + ? <= ?`
    )
    .bind(
      report.version,
      report.state,
      report.error,
      report.at,
      now,
      tenantId,
      clientId,
      BOOT_REPORT_MIN_GAP_SECONDS,
      report.at
    )
    .run();
  if (!result.meta.changes) {
    const row = await db
      .prepare("SELECT id FROM client_devices WHERE tenant_id = ? AND client_id = ?")
      .bind(tenantId, clientId)
      .first<{ id: string }>();
    return row ? "duplicate" : "unknown-workstation";
  }
  const issue = ISSUES[report.state];
  if (issue) {
    // Waiting for the hourly bug report run only if the organization had
    // opted in when it happened (src/bug_reports.ts).
    await db
      .prepare(
        `INSERT INTO workstation_issues (id, tenant_id, client_id, severity, kind, image_version, details, occurred_at, created_at, report_state)
         SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, CASE WHEN bug_reports_enabled = 1 THEN 'pending' ELSE 'none' END
           FROM tenants WHERE id = ?`
      )
      .bind(
        crypto.randomUUID(),
        clientId,
        issue.severity,
        issue.kind,
        report.version,
        describeBootReport(report),
        report.at,
        now,
        tenantId
      )
      .run();
  }
  return "recorded";
}

// ------------------------------------------------------------ restart reports

/**
 * A boot that ended without shutting down, as the next boot found it in the
 * journal labkiosk-logs keeps on LABKIOSK_DATA. The agent sends it with
 * POST /api/devices/restart-report, once per boot, until the Worker answers.
 */
export const RESTART_KINDS = ["unexpected_restart", "watchdog_reset"] as const;
export type RestartKind = (typeof RESTART_KINDS)[number];

/** systemd's boot id, as journalctl prints it: 128 bits of hex, no dashes. */
const BOOT_ID_PATTERN = /^[0-9a-f]{32}$/;
/** The end of the journal kept with the issue; the agent sends no more. */
export const MAX_RESTART_LOG_CHARS = 16 * 1024;
/** Restart logs are cleared after this; the issue itself stays for WORKSTATION_ISSUE_RETENTION_DAYS. */
export const RESTART_LOG_RETENTION_DAYS = 30;
/**
 * At most this many restart reports per workstation per day. A machine in a
 * reboot loop still shows up; one replaying invented boots cannot flood
 * Errors & Warnings or the database with logs.
 */
export const MAX_RESTART_REPORTS_PER_DAY = 24;

export interface RestartReport {
  bootId: string;
  kind: RestartKind;
  /** The system image that boot ran, when it could be read. */
  version: string | null;
  startedAt: number;
  /** The journal's last entry from that boot. */
  endedAt: number;
  log: string;
}

const RESTART_ISSUES: Record<RestartKind, "error" | "warning"> = {
  // A power cut or someone holding the power button looks exactly like this.
  unexpected_restart: "warning",
  // The hardware watchdog only resets a machine that stopped responding.
  watchdog_reset: "error"
};

function wholeSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be a whole number of seconds`);
  }
  return value;
}

/** Validate a restart report from a workstation; throws with the reason on anything malformed. */
export function parseRestartReport(input: unknown, now: number): RestartReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The restart report must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  const bootId = body.bootId;
  if (typeof bootId !== "string" || !BOOT_ID_PATTERN.test(bootId)) {
    throw new Error("bootId is not a boot id");
  }
  const kind = body.kind;
  if (typeof kind !== "string" || !(RESTART_KINDS as readonly string[]).includes(kind)) {
    throw new Error("kind is not a kind of restart");
  }
  const startedAt = wholeSeconds(body.startedAt, "startedAt");
  const endedAt = wholeSeconds(body.endedAt, "endedAt");
  if (endedAt < startedAt) throw new Error("endedAt is before startedAt");
  if (endedAt > now + MAX_CLOCK_AHEAD_SECONDS || endedAt < now - MAX_REPORT_AGE_SECONDS) {
    throw new Error("endedAt is outside the accepted window");
  }
  if (typeof body.log !== "string") throw new Error("log must be text");
  // Keep line breaks and tabs; any other control character would garble the
  // console, which only ever renders the log with textContent.
  const cleaned = body.log.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ");
  const log = cleaned.length > MAX_RESTART_LOG_CHARS ? cleaned.slice(cleaned.length - MAX_RESTART_LOG_CHARS) : cleaned;
  return {
    bootId,
    kind: kind as RestartKind,
    version: optionalVersion(body.version, "version"),
    startedAt,
    endedAt,
    log
  };
}

/** One line an administrator can act on, for the Errors & Warnings list. */
export function describeRestartReport(report: RestartReport): string {
  const ran = `${report.version ? `Running ${report.version}, it` : "It"} ran for ${formatDuration(report.endedAt - report.startedAt)}`;
  if (report.kind === "watchdog_reset") {
    return `${ran} and stopped responding; the hardware watchdog restarted it.`;
  }
  return `${ran} and restarted without shutting down: a power cut, a forced power-off, a hang or a crash.`;
}

function formatDuration(seconds: number): string {
  if (seconds < 120) return `${Math.max(seconds, 0)} seconds`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

export type RestartReportOutcome = "recorded" | "duplicate" | "unknown-workstation" | "too-many";

/**
 * List the restart in Errors & Warnings with its log, once per boot.
 *
 * The issue's id is derived from the organization, the workstation and the
 * boot, so the agent re-sending after a lost reply writes nothing twice.
 * Never offered as an automatic bug report: a restart without a shutdown is
 * usually the power, and the log is the organization's own.
 */
export async function recordRestartReport(
  db: D1Database,
  tenantId: string,
  clientId: string,
  report: RestartReport,
  now: number
): Promise<RestartReportOutcome> {
  const device = await db
    .prepare("SELECT id FROM client_devices WHERE tenant_id = ? AND client_id = ?")
    .bind(tenantId, clientId)
    .first<{ id: string }>();
  if (!device) return "unknown-workstation";

  const id = `restart-${(await sha256Hex(`${tenantId}:${clientId}:${report.bootId}`)).slice(0, 32)}`;
  const existing = await db
    .prepare("SELECT id FROM workstation_issues WHERE id = ? AND tenant_id = ?")
    .bind(id, tenantId)
    .first<{ id: string }>();
  if (existing) return "duplicate";

  const recent = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM workstation_issues
        WHERE tenant_id = ? AND client_id = ? AND kind IN ('unexpected_restart', 'watchdog_reset') AND created_at > ?`
    )
    .bind(tenantId, clientId, now - 86400)
    .first<{ n: number }>();
  if ((recent?.n || 0) >= MAX_RESTART_REPORTS_PER_DAY) return "too-many";

  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO workstation_issues
         (id, tenant_id, client_id, severity, kind, image_version, details, occurred_at, created_at, report_state, log_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?)`
    )
    .bind(
      id,
      tenantId,
      clientId,
      RESTART_ISSUES[report.kind],
      report.kind,
      report.version,
      describeRestartReport(report),
      report.endedAt,
      now,
      report.log || null
    )
    .run();
  return result.meta.changes ? "recorded" : "duplicate";
}

/**
 * The log kept with one of an organization's issues. `undefined` when the
 * organization has no such issue; `null` when it has no log (any other kind,
 * or one past RESTART_LOG_RETENTION_DAYS).
 */
export async function getWorkstationIssueLog(
  db: D1Database,
  tenantId: string,
  issueId: string
): Promise<string | null | undefined> {
  const row = await db
    .prepare("SELECT log_text FROM workstation_issues WHERE id = ? AND tenant_id = ?")
    .bind(issueId, tenantId)
    .first<{ log_text: string | null }>();
  if (!row) return undefined;
  return row.log_text ?? null;
}

/** An organization's errors and warnings, newest first. */
export async function listWorkstationIssues(db: D1Database, tenantId: string, limit = 100): Promise<WorkstationIssue[]> {
  const res = await db
    .prepare(
      `SELECT i.id, i.client_id, i.severity, i.kind, i.image_version, i.details, i.occurred_at, i.created_at,
              CASE WHEN i.log_text IS NULL THEN 0 ELSE 1 END AS has_log, i.report_state, i.report_match, b.issue_url, b.issue_number, b.status AS report_status, b.pr_url
         FROM workstation_issues i LEFT JOIN bug_reports b ON b.signature = i.bug_signature
        WHERE i.tenant_id = ? ORDER BY i.created_at DESC, i.occurred_at DESC LIMIT ?`
    )
    .bind(tenantId, Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_ISSUES_LISTED))
    .all<WorkstationIssue>();
  return res.results || [];
}

/**
 * Delete issues past the retention period, and clear restart logs past theirs,
 * for every organization. Returns how many issues were deleted.
 */
export async function purgeOldWorkstationIssues(db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<number> {
  await db
    .prepare("UPDATE workstation_issues SET log_text = NULL WHERE log_text IS NOT NULL AND created_at < ?")
    .bind(now - RESTART_LOG_RETENTION_DAYS * 86400)
    .run();
  const res = await db
    .prepare("DELETE FROM workstation_issues WHERE created_at < ?")
    .bind(now - WORKSTATION_ISSUE_RETENTION_DAYS * 86400)
    .run();
  return res.meta.changes || 0;
}
