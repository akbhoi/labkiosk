/**
 * Boot reports: what an installed workstation's last boot did with its system image.
 *
 * `labkiosk-boot-slots check` (root, on the workstation) writes the outcome to
 * /run/labkiosk-update/status.json; the agent sends it here with
 * POST /api/devices/boot-report. The latest outcome is kept on the
 * workstation's `client_devices` row and each new one goes to the
 * organization's audit log, so an administrator sees a failed update or a
 * rollback in Settings -> Security & Audit without touching the machine.
 */
import { writeAuditLog } from "./db";

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
 * one replaying invented reports cannot flood the audit log.
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

const AUDIT_ACTIONS: Record<BootReportState, string> = {
  installed: "workstation.update_installed",
  failed: "workstation.update_failed",
  "rolled-back": "workstation.update_rolled_back",
  fallback: "workstation.boot_fallback",
  error: "workstation.boot_error"
};

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

/** The audit entry's details, in the `key=value` form the other entries use. */
export function describeBootReport(clientId: string, report: BootReport): string {
  const parts = [`client=${clientId}`, `running=${report.version}`];
  if (report.previous) parts.push(`previous=${report.previous}`);
  if (report.failed) parts.push(`failed=${report.failed}`);
  if (report.error) parts.push(`error=${report.error}`);
  return parts.join(" ");
}

export type BootReportOutcome = "recorded" | "duplicate" | "unknown-workstation";

/**
 * Keep the report on the workstation's row and audit it, once.
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
  await writeAuditLog(db, {
    tenantId,
    action: AUDIT_ACTIONS[report.state],
    details: describeBootReport(clientId, report)
  });
  return "recorded";
}
