/**
 * The monthly summary an organization's administrators see on Workstations for
 * the first half of each month: what its workstations did last month, from the
 * usage they already report (src/usage.ts) and the problems they reported
 * (workstation_issues). Computed when the page is drawn, never stored, never
 * emailed. "Got it" hides it until next month (tenants.summary_dismissed_month);
 * Settings -> Usage has the full history.
 */

import { Tenant } from "./types";

/** The summary shows on days 1 to SHOW_DAYS of a month (UTC). */
export const SHOW_DAYS = 14;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MonthlySummary {
  /** "2026-10" */
  month: string;
  /** "October 2026" */
  label: string;
  activeHours: number;
  /** The month before, for the comparison; null when it had no usage. */
  previousActiveHours: number | null;
  sessions: number;
  workstations: number;
  busiestDay: { day: string; activeHours: number } | null;
  topSites: Array<{ domain: string; activeHours: number }>;
  problems: number;
  bugReports: number;
}

export function isSummaryMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_PATTERN.test(value);
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function monthBounds(month: string): { from: string; to: string; fromSeconds: number; toSeconds: number } {
  const [y, m] = month.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  return {
    from: month + "-01",
    to: new Date(end - 86_400_000).toISOString().slice(0, 10),
    fromSeconds: start / 1000,
    toSeconds: end / 1000
  };
}

function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

/** The month before `now`'s, as "YYYY-MM". */
export function previousMonth(now: number): string {
  const d = new Date(now);
  return monthOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
}

/** Last month's summary, when it is due and not dismissed and there was usage; else null. */
export async function monthlySummaryFor(db: D1Database, tenant: Tenant, now = Date.now()): Promise<MonthlySummary | null> {
  if (tenant.status !== "active") return null;
  if (new Date(now).getUTCDate() > SHOW_DAYS) return null;
  const month = previousMonth(now);
  if (tenant.summary_dismissed_month === month) return null;
  const range = monthBounds(month);
  const before = monthBounds(previousMonth(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 15)));

  const [totals, previous, busiest, sites, issues] = await Promise.all([
    db
      .prepare(
        "SELECT SUM(active_seconds) AS active, SUM(sessions) AS sessions, COUNT(DISTINCT client_id) AS workstations FROM usage_daily WHERE tenant_id = ? AND day BETWEEN ? AND ?"
      )
      .bind(tenant.id, range.from, range.to)
      .first<{ active: number | null; sessions: number | null; workstations: number }>(),
    db
      .prepare("SELECT SUM(active_seconds) AS active FROM usage_daily WHERE tenant_id = ? AND day BETWEEN ? AND ?")
      .bind(tenant.id, before.from, before.to)
      .first<{ active: number | null }>(),
    db
      .prepare(
        "SELECT day, SUM(active_seconds) AS active FROM usage_daily WHERE tenant_id = ? AND day BETWEEN ? AND ? GROUP BY day ORDER BY active DESC, day LIMIT 1"
      )
      .bind(tenant.id, range.from, range.to)
      .first<{ day: string; active: number }>(),
    tenant.usage_sites === 0
      ? Promise.resolve({ results: [] as Array<{ domain: string; active: number }> })
      : db
          .prepare(
            "SELECT domain, SUM(active_seconds) AS active FROM usage_sites WHERE tenant_id = ? AND day BETWEEN ? AND ? GROUP BY domain ORDER BY active DESC, domain LIMIT 3"
          )
          .bind(tenant.id, range.from, range.to)
          .all<{ domain: string; active: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS problems, SUM(CASE WHEN report_state = 'sent' THEN 1 ELSE 0 END) AS reported FROM workstation_issues WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ?"
      )
      .bind(tenant.id, range.fromSeconds, range.toSeconds)
      .first<{ problems: number; reported: number | null }>()
  ]);

  const active = Number(totals?.active ?? 0);
  if (!active) return null;
  const previousActive = Number(previous?.active ?? 0);
  return {
    month,
    label: new Date(range.fromSeconds * 1000).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    activeHours: hours(active),
    previousActiveHours: previousActive ? hours(previousActive) : null,
    sessions: Number(totals?.sessions ?? 0),
    workstations: Number(totals?.workstations ?? 0),
    busiestDay: busiest ? { day: busiest.day, activeHours: hours(Number(busiest.active)) } : null,
    topSites: (sites.results ?? []).filter((s) => Number(s.active) > 0).map((s) => ({ domain: s.domain, activeHours: hours(Number(s.active)) })),
    problems: Number(issues?.problems ?? 0),
    bugReports: Number(issues?.reported ?? 0)
  };
}
