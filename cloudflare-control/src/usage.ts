/**
 * Usage reports: how much each workstation is on and in use, and which sites
 * its users spend that time on.
 *
 * A workstation's agent counts, per calendar day of its own clock: the seconds
 * it was powered on, the seconds someone was using it (keyboard, mouse or
 * touch in the last minute, from Chromium's idle state), the fresh sessions
 * it started, and -- when the organization records sites -- the seconds in
 * use and the visits on each site's hostname. It sends what it counted every
 * USAGE_REPORT_SECONDS with POST /api/devices/usage, and the counts are added
 * to usage_daily and usage_sites here. Only a hostname is kept: never the
 * full address, the page, or who was at the workstation.
 *
 * The console's Reports page reads them back by day, by workstation and by
 * site. The hourly cron deletes rows older than USAGE_RETENTION_DAYS, and
 * builds the platform's anonymous daily totals: platform_usage_daily (how many
 * organizations and workstations, and their seconds and sessions) and
 * platform_usage_sites (a site only once PLATFORM_SITE_MIN_ORGANIZATIONS
 * organizations visited it that day). Neither names an organization, and both
 * leave out the platform's demos.
 */

import { DEMO_SLUGS } from "./demo";

/** Days of an organization's usage kept. */
export const USAGE_RETENTION_DAYS = 400;
/** Days a report may reach back: an agent that could not send keeps counting. */
export const USAGE_REPORT_MAX_AGE_DAYS = 7;
/** Days the platform's totals are rebuilt for each hour; older days no longer change. */
export const PLATFORM_ROLLUP_DAYS = USAGE_REPORT_MAX_AGE_DAYS + 1;
/** A site shows in the platform's totals once this many organizations visited it on a day. */
export const PLATFORM_SITE_MIN_ORGANIZATIONS = 3;
/** The longest a calendar day lasts (a day the clocks go back), with some slack for clock steps. */
export const MAX_DAY_SECONDS = 25 * 3600 + 600;
export const MAX_DAYS_PER_REPORT = USAGE_REPORT_MAX_AGE_DAYS + 2;
export const MAX_SITES_PER_DAY = 100;
/** The longest period the Reports page shows at once. */
export const MAX_REPORT_DAYS = 366;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export interface UsageSite {
  domain: string;
  seconds: number;
  visits: number;
}

export interface UsageDay {
  day: string;
  onSeconds: number;
  activeSeconds: number;
  sessions: number;
  sites: UsageSite[];
}

function whole(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${field} must be a whole number from 0 to ${max}`);
  }
  return value;
}

/** YYYY-MM-DD of a moment, in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * Validate a usage report; throws with the reason on anything malformed.
 *
 * A day is the workstation's own calendar day, so it may run up to a day
 * ahead of UTC and must be no older than USAGE_REPORT_MAX_AGE_DAYS. A site
 * that is not a hostname with a dot in it (an IP address, localhost, the
 * agent's own pages) is left out rather than refused.
 */
export function parseUsageReport(input: unknown, now = Date.now()): UsageDay[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The usage report must be a JSON object");
  }
  const days = (input as Record<string, unknown>).days;
  if (!Array.isArray(days) || days.length === 0 || days.length > MAX_DAYS_PER_REPORT) {
    throw new Error(`days must list 1 to ${MAX_DAYS_PER_REPORT} days`);
  }
  const earliest = dayMs(utcDay(now)) - (USAGE_REPORT_MAX_AGE_DAYS + 1) * 86_400_000;
  const latest = dayMs(utcDay(now)) + 86_400_000;
  const seen = new Set<string>();
  return days.map((entry, index): UsageDay => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`days[${index}] must be an object`);
    const raw = entry as Record<string, unknown>;
    const day = typeof raw.day === "string" ? raw.day : "";
    const at = DAY_PATTERN.test(day) ? dayMs(day) : NaN;
    if (!Number.isFinite(at) || utcDay(at) !== day) throw new Error(`days[${index}].day is not a YYYY-MM-DD date`);
    if (at < earliest || at > latest) throw new Error(`days[${index}].day is outside the days a report may cover`);
    if (seen.has(day)) throw new Error(`days[${index}].day is listed twice`);
    seen.add(day);
    const onSeconds = whole(raw.onSeconds, `days[${index}].onSeconds`, MAX_DAY_SECONDS);
    // In use is counted by the browser and powered on by the agent, so the
    // two can disagree by a tick; in use never exceeds on.
    const activeSeconds = Math.min(onSeconds, whole(raw.activeSeconds, `days[${index}].activeSeconds`, MAX_DAY_SECONDS));
    const sessions = whole(raw.sessions, `days[${index}].sessions`, 100_000);
    const rawSites = raw.sites ?? [];
    if (!Array.isArray(rawSites) || rawSites.length > MAX_SITES_PER_DAY) {
      throw new Error(`days[${index}].sites must list at most ${MAX_SITES_PER_DAY} sites`);
    }
    const sites = new Map<string, UsageSite>();
    for (const [siteIndex, site] of rawSites.entries()) {
      if (!site || typeof site !== "object" || Array.isArray(site)) throw new Error(`days[${index}].sites[${siteIndex}] must be an object`);
      const s = site as Record<string, unknown>;
      if (typeof s.domain !== "string") throw new Error(`days[${index}].sites[${siteIndex}].domain must be text`);
      const seconds = Math.min(activeSeconds, whole(s.seconds, `days[${index}].sites[${siteIndex}].seconds`, MAX_DAY_SECONDS));
      const visits = whole(s.visits, `days[${index}].sites[${siteIndex}].visits`, 100_000);
      const domain = s.domain.toLowerCase().replace(/\.$/, "");
      if (!HOSTNAME_PATTERN.test(domain)) continue;
      const known = sites.get(domain);
      sites.set(domain, known ? { domain, seconds: Math.min(activeSeconds, known.seconds + seconds), visits: known.visits + visits } : { domain, seconds, visits });
    }
    return { day, onSeconds, activeSeconds, sessions, sites: [...sites.values()] };
  });
}

/**
 * Add a report's counts to the organization's usage. Sites are kept only when
 * the organization records them. One batch, so a report counts once or not at all.
 */
export async function recordUsage(
  db: D1Database,
  tenantId: string,
  clientId: string,
  days: UsageDay[],
  recordSites: boolean
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const d of days) {
    statements.push(
      db
        .prepare(
          `INSERT INTO usage_daily (tenant_id, client_id, day, on_seconds, active_seconds, sessions) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, client_id, day) DO UPDATE SET
             on_seconds = MIN(${MAX_DAY_SECONDS}, on_seconds + excluded.on_seconds),
             active_seconds = MIN(${MAX_DAY_SECONDS}, active_seconds + excluded.active_seconds),
             sessions = sessions + excluded.sessions`
        )
        .bind(tenantId, clientId, d.day, d.onSeconds, d.activeSeconds, d.sessions)
    );
    if (!recordSites) continue;
    for (const site of d.sites) {
      if (!site.seconds && !site.visits) continue;
      statements.push(
        db
          .prepare(
            `INSERT INTO usage_sites (tenant_id, day, domain, active_seconds, visits) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(tenant_id, day, domain) DO UPDATE SET
               active_seconds = active_seconds + excluded.active_seconds,
               visits = visits + excluded.visits`
          )
          .bind(tenantId, d.day, site.domain, site.seconds, site.visits)
      );
    }
  }
  await db.batch(statements);
}

export interface UsageSummary {
  from: string;
  to: string;
  days: Array<{ day: string; workstations: number; onSeconds: number; activeSeconds: number; sessions: number }>;
  workstations: Array<{ clientId: string; groupName: string | null; daysOn: number; onSeconds: number; activeSeconds: number; sessions: number; lastDay: string }>;
  sites: Array<{ domain: string; activeSeconds: number; visits: number }>;
  recordSites: boolean;
}

/** The period ending today (UTC) that is `days` long, as the first and last day. */
export function reportPeriod(days: number, now = Date.now()): { from: string; to: string } {
  // A workstation ahead of UTC may already report tomorrow.
  const to = utcDay(now + 86_400_000);
  return { from: utcDay(dayMs(to) - days * 86_400_000), to };
}

/** An organization's usage over a period: per day, per workstation and per site. */
export async function usageSummary(
  db: D1Database,
  tenantId: string,
  period: { from: string; to: string },
  recordSites: boolean
): Promise<UsageSummary> {
  const [days, workstations, sites] = await Promise.all([
    db
      .prepare(
        `SELECT day, COUNT(*) AS workstations, SUM(on_seconds) AS on_seconds, SUM(active_seconds) AS active_seconds, SUM(sessions) AS sessions
         FROM usage_daily WHERE tenant_id = ? AND day BETWEEN ? AND ? GROUP BY day ORDER BY day`
      )
      .bind(tenantId, period.from, period.to)
      .all<{ day: string; workstations: number; on_seconds: number; active_seconds: number; sessions: number }>(),
    db
      .prepare(
        `SELECT u.client_id AS client_id, d.group_name AS group_name, COUNT(*) AS days_on, SUM(u.on_seconds) AS on_seconds,
                SUM(u.active_seconds) AS active_seconds, SUM(u.sessions) AS sessions, MAX(u.day) AS last_day
         FROM usage_daily u LEFT JOIN client_devices d ON d.tenant_id = u.tenant_id AND d.client_id = u.client_id
         WHERE u.tenant_id = ? AND u.day BETWEEN ? AND ?
         GROUP BY u.client_id ORDER BY active_seconds DESC, u.client_id LIMIT 500`
      )
      .bind(tenantId, period.from, period.to)
      .all<{ client_id: string; group_name: string | null; days_on: number; on_seconds: number; active_seconds: number; sessions: number; last_day: string }>(),
    db
      .prepare(
        `SELECT domain, SUM(active_seconds) AS active_seconds, SUM(visits) AS visits
         FROM usage_sites WHERE tenant_id = ? AND day BETWEEN ? AND ?
         GROUP BY domain ORDER BY active_seconds DESC, visits DESC, domain LIMIT 100`
      )
      .bind(tenantId, period.from, period.to)
      .all<{ domain: string; active_seconds: number; visits: number }>()
  ]);
  return {
    ...period,
    days: (days.results ?? []).map((r) => ({
      day: r.day,
      workstations: Number(r.workstations),
      onSeconds: Number(r.on_seconds),
      activeSeconds: Number(r.active_seconds),
      sessions: Number(r.sessions)
    })),
    workstations: (workstations.results ?? []).map((r) => ({
      clientId: r.client_id,
      groupName: r.group_name ?? null,
      daysOn: Number(r.days_on),
      onSeconds: Number(r.on_seconds),
      activeSeconds: Number(r.active_seconds),
      sessions: Number(r.sessions),
      lastDay: r.last_day
    })),
    sites: (sites.results ?? []).map((r) => ({ domain: r.domain, activeSeconds: Number(r.active_seconds), visits: Number(r.visits) })),
    recordSites
  };
}

/** Delete an organization's recorded sites, every day of them. */
export async function deleteUsageSites(db: D1Database, tenantId: string): Promise<number> {
  const result = await db.prepare("DELETE FROM usage_sites WHERE tenant_id = ?").bind(tenantId).run();
  return result.meta.changes;
}

/** Delete usage older than USAGE_RETENTION_DAYS. Returns the rows deleted. */
export async function purgeOldUsage(db: D1Database, now = Date.now()): Promise<number> {
  const cutoff = utcDay(now - USAGE_RETENTION_DAYS * 86_400_000);
  const [daily, sites] = await db.batch([
    db.prepare("DELETE FROM usage_daily WHERE day < ?").bind(cutoff),
    db.prepare("DELETE FROM usage_sites WHERE day < ?").bind(cutoff)
  ]);
  return daily.meta.changes + sites.meta.changes;
}

/**
 * Rebuild the platform's anonymous totals for the days reports may still
 * reach. A day's rows are replaced together, so a site that fewer
 * organizations visited after all leaves the list.
 */
export async function rollUpPlatformUsage(db: D1Database, now = Date.now()): Promise<void> {
  const from = utcDay(now - PLATFORM_ROLLUP_DAYS * 86_400_000);
  const computedAt = Math.floor(now / 1000);
  const demoMarks = DEMO_SLUGS.map(() => "?").join(", ");
  const notDemo = `tenant_id NOT IN (SELECT id FROM tenants WHERE subdomain IN (${demoMarks}))`;
  await db.batch([
    db.prepare("DELETE FROM platform_usage_daily WHERE day >= ?").bind(from),
    db
      .prepare(
        `INSERT INTO platform_usage_daily (day, organizations, workstations, on_seconds, active_seconds, sessions, computed_at)
         SELECT day, COUNT(DISTINCT tenant_id), COUNT(*), SUM(on_seconds), SUM(active_seconds), SUM(sessions), ?
         FROM usage_daily WHERE day >= ? AND ${notDemo} GROUP BY day`
      )
      .bind(computedAt, from, ...DEMO_SLUGS),
    db.prepare("DELETE FROM platform_usage_sites WHERE day >= ?").bind(from),
    db
      .prepare(
        `INSERT INTO platform_usage_sites (day, domain, organizations, active_seconds, visits)
         SELECT day, domain, COUNT(DISTINCT tenant_id), SUM(active_seconds), SUM(visits)
         FROM usage_sites WHERE day >= ? AND ${notDemo}
         GROUP BY day, domain HAVING COUNT(DISTINCT tenant_id) >= ?`
      )
      .bind(from, ...DEMO_SLUGS, PLATFORM_SITE_MIN_ORGANIZATIONS)
  ]);
}

export interface PlatformUsage {
  from: string;
  to: string;
  days: Array<{ day: string; organizations: number; workstations: number; onSeconds: number; activeSeconds: number; sessions: number }>;
  sites: Array<{ domain: string; organizations: number; activeSeconds: number; visits: number }>;
}

/**
 * The platform's anonymous totals over a period. A site's organizations is the
 * most that visited it on any one day, since the same organization visits on
 * many days.
 */
export async function platformUsage(db: D1Database, period: { from: string; to: string }): Promise<PlatformUsage> {
  const [days, sites] = await Promise.all([
    db
      .prepare(
        `SELECT day, organizations, workstations, on_seconds, active_seconds, sessions
         FROM platform_usage_daily WHERE day BETWEEN ? AND ? ORDER BY day`
      )
      .bind(period.from, period.to)
      .all<{ day: string; organizations: number; workstations: number; on_seconds: number; active_seconds: number; sessions: number }>(),
    db
      .prepare(
        `SELECT domain, MAX(organizations) AS organizations, SUM(active_seconds) AS active_seconds, SUM(visits) AS visits
         FROM platform_usage_sites WHERE day BETWEEN ? AND ?
         GROUP BY domain ORDER BY active_seconds DESC, domain LIMIT 50`
      )
      .bind(period.from, period.to)
      .all<{ domain: string; organizations: number; active_seconds: number; visits: number }>()
  ]);
  return {
    ...period,
    days: (days.results ?? []).map((r) => ({
      day: r.day,
      organizations: Number(r.organizations),
      workstations: Number(r.workstations),
      onSeconds: Number(r.on_seconds),
      activeSeconds: Number(r.active_seconds),
      sessions: Number(r.sessions)
    })),
    sites: (sites.results ?? []).map((r) => ({
      domain: r.domain,
      organizations: Number(r.organizations),
      activeSeconds: Number(r.active_seconds),
      visits: Number(r.visits)
    }))
  };
}
