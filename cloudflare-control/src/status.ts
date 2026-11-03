/**
 * The platform's public status: what the automatic checks found, and incidents
 * the super admin posts. Shown at /status, and an open incident as a banner in
 * every organization's console.
 *
 * A 5-minute cron runs the checks (`runStatusChecks`). Each check's latest
 * result is kept in `status_latest`; `status_daily` counts checks and failures
 * per component per UTC day for the 90-day strip. A page served by this Worker
 * cannot say the Worker itself is down: `/api/health` is there for an outside
 * monitor to watch (docs/DEPLOYMENT.md).
 */

import { mailConfigProblem } from "./mail";
import { Env } from "./types";

export const STATUS_DAYS = 90;
/** Resolved incidents older than this are deleted; daily counts older than STATUS_DAYS too. */
const INCIDENT_RETENTION_DAYS = 365;
export const INCIDENT_LIMITS = { title: 120, body: 2000 } as const;

export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_IMPACTS = ["minor", "major"] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

export type StatusComponent = "console" | "workstations" | "email" | "updates";

export const COMPONENT_LABELS: Record<StatusComponent, string> = {
  console: "Console and sign-in",
  workstations: "Workstation connections",
  email: "Email",
  updates: "Updates and downloads"
};

export interface CheckResult {
  component: StatusComponent;
  ok: boolean;
  detail: string | null;
}

export interface ComponentStatus {
  component: StatusComponent;
  label: string;
  ok: boolean | null;
  detail: string | null;
  checkedAt: number | null;
  /** Oldest first, one per day of the last STATUS_DAYS: null where nothing was checked. */
  days: Array<{ day: string; checks: number; failures: number } | null>;
}

export interface Incident {
  id: string;
  title: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  created_at: number;
  resolved_at: number | null;
  updates: Array<{ id: string; status: IncidentStatus; body: string; created_at: number }>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** The components this deployment has: Updates only with a releases bucket. */
export function statusComponents(env: Env): StatusComponent[] {
  return env.RELEASES ? ["console", "workstations", "email", "updates"] : ["console", "workstations", "email"];
}

/** Run every check once. Never throws: a failed check is a result. */
export async function checkComponents(env: Env, db: D1Database): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    await db.prepare("SELECT 1").first();
    results.push({ component: "console", ok: true, detail: null });
  } catch (err) {
    results.push({ component: "console", ok: false, detail: `Database: ${message(err)}` });
  }
  try {
    if (!env.ORG_HUB) throw new Error("ORG_HUB is not bound");
    const hub = env.ORG_HUB.get(env.ORG_HUB.idFromName("__status_probe__"));
    const res = await hub.fetch("https://org-hub/ping");
    results.push({ component: "workstations", ok: res.ok, detail: res.ok ? null : `Hub answered ${res.status}` });
  } catch (err) {
    results.push({ component: "workstations", ok: false, detail: message(err) });
  }
  const mailProblem = mailConfigProblem(env);
  results.push({ component: "email", ok: !mailProblem, detail: mailProblem });
  if (env.RELEASES) {
    try {
      await env.RELEASES.list({ limit: 1 });
      results.push({ component: "updates", ok: true, detail: null });
    } catch (err) {
      results.push({ component: "updates", ok: false, detail: `Releases bucket: ${message(err)}` });
    }
  }
  return results;
}

/** Record a round of results: the latest per component, and today's counts. */
export async function recordStatusChecks(db: D1Database, results: CheckResult[], at = nowSeconds()): Promise<void> {
  const day = utcDay(at);
  const statements = results.flatMap((r) => [
    db
      .prepare(
        "INSERT INTO status_latest (component, ok, detail, checked_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(component) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, checked_at = excluded.checked_at"
      )
      .bind(r.component, r.ok ? 1 : 0, r.detail, at),
    db
      .prepare(
        "INSERT INTO status_daily (component, day, checks, failures) VALUES (?, ?, 1, ?) " +
          "ON CONFLICT(component, day) DO UPDATE SET checks = checks + 1, failures = failures + excluded.failures"
      )
      .bind(r.component, day, r.ok ? 0 : 1)
  ]);
  if (statements.length) await db.batch(statements);
}

/** The 5-minute cron's work. */
export async function runStatusChecks(env: Env, db: D1Database): Promise<CheckResult[]> {
  const results = await checkComponents(env, db);
  await recordStatusChecks(db, results);
  return results;
}

export async function purgeOldStatus(db: D1Database, at = nowSeconds()): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM status_daily WHERE day < ?").bind(utcDay(at - STATUS_DAYS * 86400)),
    db.prepare("DELETE FROM status_incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?").bind(at - INCIDENT_RETENTION_DAYS * 86400)
  ]);
}

/** Each component's latest result and its last STATUS_DAYS days. */
export async function componentStatuses(env: Env, db: D1Database, at = nowSeconds()): Promise<ComponentStatus[]> {
  const first = utcDay(at - (STATUS_DAYS - 1) * 86400);
  const [latest, daily] = await Promise.all([
    db.prepare("SELECT component, ok, detail, checked_at FROM status_latest").all<{ component: string; ok: number; detail: string | null; checked_at: number }>(),
    db
      .prepare("SELECT component, day, checks, failures FROM status_daily WHERE day >= ?")
      .bind(first)
      .all<{ component: string; day: string; checks: number; failures: number }>()
  ]);
  const days: string[] = [];
  for (let i = STATUS_DAYS - 1; i >= 0; i--) days.push(utcDay(at - i * 86400));
  return statusComponents(env).map((component) => {
    const row = latest.results.find((r) => r.component === component);
    const counts = new Map(daily.results.filter((d) => d.component === component).map((d) => [d.day, d]));
    return {
      component,
      label: COMPONENT_LABELS[component],
      ok: row ? row.ok === 1 : null,
      detail: row?.detail ?? null,
      checkedAt: row?.checked_at ?? null,
      days: days.map((day) => {
        const d = counts.get(day);
        return d ? { day, checks: d.checks, failures: d.failures } : null;
      })
    };
  });
}

/** Incidents opened in the last STATUS_DAYS days or still open, newest first, each with its updates. */
export async function listIncidents(db: D1Database, at = nowSeconds()): Promise<Incident[]> {
  const incidents = await db
    .prepare(
      "SELECT id, title, impact, status, created_at, resolved_at FROM status_incidents " +
        "WHERE resolved_at IS NULL OR created_at >= ? ORDER BY created_at DESC LIMIT 50"
    )
    .bind(at - STATUS_DAYS * 86400)
    .all<Omit<Incident, "updates">>();
  if (!incidents.results.length) return [];
  const updates = await db
    .prepare(
      `SELECT id, incident_id, status, body, created_at FROM status_incident_updates WHERE incident_id IN (${incidents.results
        .map(() => "?")
        .join(", ")}) ORDER BY created_at DESC`
    )
    .bind(...incidents.results.map((i) => i.id))
    .all<{ id: string; incident_id: string; status: IncidentStatus; body: string; created_at: number }>();
  return incidents.results.map((i) => ({
    ...i,
    updates: updates.results.filter((u) => u.incident_id === i.id).map(({ incident_id: _incident, ...u }) => u)
  }));
}

/** The open incident an organization's console shows, the most severe and newest first. */
export async function openIncident(db: D1Database): Promise<Pick<Incident, "id" | "title" | "impact" | "status"> | null> {
  return db
    .prepare(
      "SELECT id, title, impact, status FROM status_incidents WHERE resolved_at IS NULL " +
        "ORDER BY CASE impact WHEN 'major' THEN 0 ELSE 1 END, created_at DESC LIMIT 1"
    )
    .first<Pick<Incident, "id" | "title" | "impact" | "status">>();
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Open an incident with its first update. Returns the problem, or the new id. */
export async function createIncident(
  db: D1Database,
  input: { title?: unknown; impact?: unknown; body?: unknown },
  userId: string
): Promise<{ problem: string } | { id: string }> {
  const title = cleanText(input.title, INCIDENT_LIMITS.title);
  const body = cleanText(input.body, INCIDENT_LIMITS.body);
  if (!title) return { problem: "An incident needs a title" };
  if (!body) return { problem: "Say what is happening in the first update" };
  if (!(INCIDENT_IMPACTS as readonly unknown[]).includes(input.impact)) return { problem: "Impact is minor or major" };
  const id = crypto.randomUUID();
  const at = nowSeconds();
  await db.batch([
    db
      .prepare("INSERT INTO status_incidents (id, title, impact, status, created_at, resolved_at, created_by) VALUES (?, ?, ?, 'investigating', ?, NULL, ?)")
      .bind(id, title, input.impact, at, userId),
    db
      .prepare("INSERT INTO status_incident_updates (id, incident_id, status, body, created_at) VALUES (?, ?, 'investigating', ?, ?)")
      .bind(crypto.randomUUID(), id, body, at)
  ]);
  return { id };
}

/** Post an update; `resolved` closes the incident. */
export async function updateIncident(
  db: D1Database,
  id: string,
  input: { status?: unknown; body?: unknown }
): Promise<{ problem: string; status: number } | { ok: true }> {
  const body = cleanText(input.body, INCIDENT_LIMITS.body);
  if (!body) return { problem: "An update needs a message", status: 400 };
  if (!(INCIDENT_STATUSES as readonly unknown[]).includes(input.status)) {
    return { problem: `Status is one of ${INCIDENT_STATUSES.join(", ")}`, status: 400 };
  }
  const incident = await db.prepare("SELECT resolved_at FROM status_incidents WHERE id = ?").bind(id).first<{ resolved_at: number | null }>();
  if (!incident) return { problem: "Incident not found", status: 404 };
  if (incident.resolved_at) return { problem: "This incident is resolved", status: 409 };
  const status = input.status as IncidentStatus;
  const at = nowSeconds();
  await db.batch([
    db.prepare("UPDATE status_incidents SET status = ?, resolved_at = ? WHERE id = ?").bind(status, status === "resolved" ? at : null, id),
    db
      .prepare("INSERT INTO status_incident_updates (id, incident_id, status, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), id, status, body, at)
  ]);
  return { ok: true };
}
