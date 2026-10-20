/**
 * Power schedules and Wake-on-LAN (Settings -> Power, wiki/Power-Schedules.md).
 *
 * A schedule says on which days of the week workstations switch themselves
 * off, at what time, and optionally when they switch on again. Times are the
 * workstation's own clock, as the usage reports' days are: an organization
 * spread over time zones gets each office's local time without a zone column.
 *
 * Which schedule a workstation follows is decided per day of the week: its
 * group's schedule for that day when its group has one, otherwise the
 * all-workstations schedule for that day, otherwise none (it stays on). Two
 * schedules for the same workstations (both for all, or both for one group)
 * never share a day, so every day has at most one switch-off and one switch-on
 * for every workstation. OrgHub sends each workstation its own week
 * (`power` in its configuration); the agent warns for POWER_WARNING_MINUTES at
 * the switch-off time, shuts down cleanly, and first sets the machine's
 * hardware clock to wake it at the next switch-on.
 *
 * Wake-on-LAN reaches a workstation that is off through a workstation of the
 * same organization that is on at the same site (src/lan_sharing.ts's
 * siteKey): OrgHub sends that one a `wake` command carrying the MAC addresses
 * the sleeping workstation reported in its own hardware report, and its agent
 * broadcasts the magic packet on its wired network. Nothing a console sends
 * becomes a MAC address: the route takes them from the organization's rows.
 */

import { sha256Hex } from "./auth";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** Schedules an organization may keep. */
export const MAX_POWER_SCHEDULES = 50;
/** The least time between a switch-off and a switch-on, either way round the clock. */
export const MIN_ON_OFF_GAP_MINUTES = 15;
/** How long a workstation warns before it shuts down (POWER_WARNING_SECONDS in agent.py). */
export const POWER_WARNING_MINUTES = 5;
/** The last release whose agent cannot send a magic packet: it ignores a `wake` command. */
export const LAST_AGENT_WITHOUT_WAKE = "3.2.0";
/** MAC addresses in one `wake` command; more go in another. */
export const MAX_WAKE_MACS_PER_COMMAND = 64;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const MAC_PATTERN = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const MAX_REPORT_DETAIL = 300;

/** One schedule as the console sees it. */
export interface PowerSchedule {
  id: string;
  /** The group it applies to, or null for every workstation. */
  groupId: string | null;
  groupName: string | null;
  /** Days it applies on, 0 = Sunday to 6 = Saturday. */
  days: number[];
  /** "HH:MM" on the workstation's own clock. */
  off: string;
  on: string | null;
  updatedAt: number;
}

interface PowerScheduleRow {
  id: string;
  group_id: string | null;
  group_name: string | null;
  days: number;
  off_minute: number;
  on_minute: number | null;
  updated_at: number;
}

/** A validated schedule from the console. */
export interface PowerScheduleInput {
  groupId: string | null;
  /** Bitmask, bit 0 Sunday. */
  days: number;
  offMinute: number;
  onMinute: number | null;
}

/** One day of a workstation's week: switch off at `off`, on at `on` (minutes after midnight). */
export interface PowerDay {
  off: number;
  on: number | null;
}

/** What a workstation is told: seven days, Sunday first; null where it is not switched off. */
export interface WorkstationPower {
  week: Array<PowerDay | null>;
}

/** A schedule as OrgHub applies it. */
export interface PowerRule {
  /** null: every workstation. */
  groupName: string | null;
  /** It names a group that no longer exists: it applies to nobody. */
  orphaned: boolean;
  days: number;
  off: number;
  on: number | null;
}

/** "HH:MM" to minutes after midnight; throws with the reason. */
export function parseClockTime(value: unknown, field: string): number {
  const match = typeof value === "string" ? TIME_PATTERN.exec(value) : null;
  if (!match) throw new Error(`${field} is a time from 00:00 to 23:59`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClockTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function daysToMask(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) {
    throw new Error("days lists one to seven days, 0 (Sunday) to 6 (Saturday)");
  }
  let mask = 0;
  for (const day of value) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error("days lists one to seven days, 0 (Sunday) to 6 (Saturday)");
    }
    if (mask & (1 << day)) throw new Error(`${DAY_NAMES[day]} is listed twice`);
    mask |= 1 << day;
  }
  return mask;
}

function maskToDays(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((day) => mask & (1 << day));
}

function dayList(mask: number): string {
  return maskToDays(mask)
    .map((day) => DAY_NAMES[day])
    .join(", ");
}

/**
 * Validate a schedule from the console: `{days, off, on?, groupId?}`. Throws
 * with a sentence the console shows. Whether the group exists, and whether the
 * schedule collides with another, is the route's to check.
 */
export function parsePowerScheduleInput(input: unknown): PowerScheduleInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The schedule must be a JSON object");
  const body = input as Record<string, unknown>;
  const days = daysToMask(body.days);
  const offMinute = parseClockTime(body.off, "The switch-off time");
  let onMinute: number | null = null;
  if (body.on !== undefined && body.on !== null && body.on !== "") {
    onMinute = parseClockTime(body.on, "The switch-on time");
    const gap = Math.abs(onMinute - offMinute);
    if (Math.min(gap, 1440 - gap) < MIN_ON_OFF_GAP_MINUTES) {
      throw new Error(
        `Switch-on and switch-off are at least ${MIN_ON_OFF_GAP_MINUTES} minutes apart: a workstation warns for ${POWER_WARNING_MINUTES} minutes before it shuts down`
      );
    }
  }
  let groupId: string | null = null;
  if (body.groupId !== undefined && body.groupId !== null && body.groupId !== "") {
    if (typeof body.groupId !== "string" || body.groupId.length > 64) throw new Error("groupId names a workstation group");
    groupId = body.groupId;
  }
  return { groupId, days, offMinute, onMinute };
}

/**
 * Why `candidate` cannot sit beside the organization's other schedules, or
 * null. Schedules for the same workstations may not share a day; a group's
 * schedule and the all-workstations one may, and the group's wins that day.
 */
export function powerScheduleConflict(
  existing: ReadonlyArray<{ id: string; groupId: string | null; groupName: string | null; days: number[] }>,
  candidate: PowerScheduleInput,
  selfId?: string
): string | null {
  for (const other of existing) {
    if (other.id === selfId || other.groupId !== candidate.groupId) continue;
    const shared = candidate.days & other.days.reduce((mask, day) => mask | (1 << day), 0);
    if (shared) {
      const who = candidate.groupId ? `the group ${other.groupName ?? ""}`.trim() : "every workstation";
      return `Another schedule for ${who} already covers ${dayList(shared)}. One schedule per day for the same workstations: change that one, or pick other days.`;
    }
  }
  return null;
}

function scheduleOf(row: PowerScheduleRow): PowerSchedule {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_id ? row.group_name : null,
    days: maskToDays(Number(row.days)),
    off: formatClockTime(Number(row.off_minute)),
    on: row.on_minute === null ? null : formatClockTime(Number(row.on_minute)),
    updatedAt: Number(row.updated_at) * 1000
  };
}

const SCHEDULE_SELECT = `SELECT s.id, s.group_id, g.name AS group_name, s.days, s.off_minute, s.on_minute, s.updated_at
     FROM power_schedules s
     LEFT JOIN workstation_groups g ON g.id = s.group_id AND g.tenant_id = s.tenant_id
    WHERE s.tenant_id = ?`;

/**
 * The organization's schedules: every workstation's first, then by group; within
 * each, in the order of the week from Monday, as the console lists the days.
 */
export async function listPowerSchedules(db: D1Database, tenantId: string): Promise<PowerSchedule[]> {
  const { results } = await db
    .prepare(`${SCHEDULE_SELECT} ORDER BY s.group_id IS NOT NULL, g.name COLLATE NOCASE, s.off_minute, s.id`)
    .bind(tenantId)
    .all<PowerScheduleRow>();
  const firstDay = (s: PowerSchedule) => Math.min(...s.days.map((day) => (day + 6) % 7));
  // Array.prototype.sort is stable: the SQL order stands within a day.
  return (results || [])
    .map(scheduleOf)
    .sort(
      (a, b) =>
        Number(a.groupId !== null) - Number(b.groupId !== null) ||
        (a.groupName ?? "").localeCompare(b.groupName ?? "", undefined, { sensitivity: "base" }) ||
        firstDay(a) - firstDay(b)
    );
}

/** Create a schedule, or replace the one with `id`; null when `id` is not this organization's. */
export async function savePowerSchedule(
  db: D1Database,
  tenantId: string,
  input: PowerScheduleInput,
  now: number,
  id?: string
): Promise<string | null> {
  if (id) {
    const result = await db
      .prepare(
        `UPDATE power_schedules SET group_id = ?, days = ?, off_minute = ?, on_minute = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`
      )
      .bind(input.groupId, input.days, input.offMinute, input.onMinute, now, id, tenantId)
      .run();
    return result.meta.changes ? id : null;
  }
  const newId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO power_schedules (id, tenant_id, group_id, days, off_minute, on_minute, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(newId, tenantId, input.groupId, input.days, input.offMinute, input.onMinute, now, now)
    .run();
  return newId;
}

export async function deletePowerSchedule(db: D1Database, tenantId: string, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM power_schedules WHERE id = ? AND tenant_id = ?").bind(id, tenantId).run();
  return result.meta.changes > 0;
}

/** Whether any of the organization's schedules is for a group (so moving a workstation changes its week). */
export async function hasGroupPowerSchedules(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM power_schedules WHERE tenant_id = ? AND group_id IS NOT NULL LIMIT 1")
    .bind(tenantId)
    .first<{ hit: number }>();
  return Boolean(row);
}

/** How many schedules a group has: read before the group is deleted, to know whether workstations must hear of it. */
export async function groupPowerScheduleCount(db: D1Database, tenantId: string, groupId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM power_schedules WHERE tenant_id = ? AND group_id = ?")
    .bind(tenantId, groupId)
    .first<{ n: number }>();
  return Number(row?.n || 0);
}

/**
 * Delete a deleted group's schedules. D1 already did, through the foreign key;
 * this is for a database that does not enforce foreign keys.
 */
export async function deleteGroupPowerSchedules(db: D1Database, tenantId: string, groupId: string): Promise<void> {
  await db.prepare("DELETE FROM power_schedules WHERE tenant_id = ? AND group_id = ?").bind(tenantId, groupId).run();
}

/** The organization's schedules as OrgHub applies them, and each grouped workstation's group when any is for a group. */
export async function loadPowerRules(
  db: D1Database,
  tenantId: string
): Promise<{ rules: PowerRule[]; groupOf: Map<string, string> }> {
  const { results } = await db.prepare(SCHEDULE_SELECT).bind(tenantId).all<PowerScheduleRow>();
  const rules = (results || []).map((row) => ({
    groupName: row.group_id ? row.group_name : null,
    orphaned: Boolean(row.group_id) && !row.group_name,
    days: Number(row.days),
    off: Number(row.off_minute),
    on: row.on_minute === null ? null : Number(row.on_minute)
  }));
  const groupOf = new Map<string, string>();
  if (rules.some((rule) => rule.groupName)) {
    const grouped = await db
      .prepare("SELECT client_id, group_name FROM client_devices WHERE tenant_id = ? AND group_name IS NOT NULL")
      .bind(tenantId)
      .all<{ client_id: string; group_name: string }>();
    for (const row of grouped.results || []) groupOf.set(row.client_id, row.group_name);
  }
  return { rules, groupOf };
}

/**
 * One workstation's week: for each day its group's schedule, else the
 * all-workstations one, else nothing. null when it is never switched off.
 */
export function effectivePower(rules: readonly PowerRule[], groupName: string | null | undefined): WorkstationPower | null {
  const week: Array<PowerDay | null> = [];
  for (let day = 0; day < 7; day++) {
    const bit = 1 << day;
    const own = groupName ? rules.find((r) => !r.orphaned && r.groupName === groupName && r.days & bit) : undefined;
    const rule = own ?? rules.find((r) => !r.orphaned && r.groupName === null && r.days & bit);
    week.push(rule ? { off: rule.off, on: rule.on } : null);
  }
  return week.some(Boolean) ? { week } : null;
}

// ------------------------------------------------------------------ Wake-on-LAN

/** A unicast MAC address in the form hardware reports keep: what a magic packet can be addressed to. */
export function isWakeableMac(value: unknown): value is string {
  if (typeof value !== "string" || !MAC_PATTERN.test(value)) return false;
  if (value === "00:00:00:00:00:00") return false;
  return (parseInt(value.slice(0, 2), 16) & 1) === 0;
}

// ------------------------------------------------------- power reports (agent)

/** What the agent reports when it cannot set the machine to switch itself on (POWER_PROBLEMS in agent.py). */
export const WAKE_ALARM_PROBLEMS = ["no-rtc", "failed"] as const;
export type WakeAlarmProblem = (typeof WAKE_ALARM_PROBLEMS)[number];

export interface PowerReport {
  problem: WakeAlarmProblem;
  /** The switch-on it was meant for, "YYYY-MM-DD HH:MM" on its own clock. */
  wakeAt: string;
  detail: string;
}

/** Validate `POST /api/devices/power-report`; throws with the reason. */
export function parsePowerReport(input: unknown): PowerReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The power report must be a JSON object");
  const body = input as Record<string, unknown>;
  if (typeof body.problem !== "string" || !(WAKE_ALARM_PROBLEMS as readonly string[]).includes(body.problem)) {
    throw new Error(`problem is one of ${WAKE_ALARM_PROBLEMS.join(", ")}`);
  }
  if (typeof body.wakeAt !== "string" || !/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(body.wakeAt)) {
    throw new Error("wakeAt is YYYY-MM-DD HH:MM");
  }
  if (body.detail !== undefined && typeof body.detail !== "string") throw new Error("detail must be text");
  const detail = String(body.detail ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_REPORT_DETAIL);
  return { problem: body.problem as WakeAlarmProblem, wakeAt: body.wakeAt, detail };
}

/** The sentence Settings -> Errors & Warnings shows. */
export function describePowerReport(report: PowerReport): string {
  const fallback = "Use Wake on the Workstations page, which needs Wake-on-LAN in its firmware settings, or switch it on by hand.";
  if (report.problem === "no-rtc") {
    return `It has no hardware clock that can switch it on, so it did not switch itself on for ${report.wakeAt}. ${fallback}`;
  }
  return `Setting its hardware clock to switch it on at ${report.wakeAt} failed${report.detail ? `: ${report.detail}` : ""}. ${fallback}`;
}

/**
 * List a workstation's failure to arm its wake alarm under Errors & Warnings,
 * once per kind of problem and day. "unknown-workstation" when its row does not
 * exist yet.
 */
export async function recordPowerReport(
  db: D1Database,
  tenantId: string,
  clientId: string,
  report: PowerReport,
  now: number
): Promise<"recorded" | "duplicate" | "unknown-workstation"> {
  const device = await db
    .prepare("SELECT id FROM client_devices WHERE tenant_id = ? AND client_id = ?")
    .bind(tenantId, clientId)
    .first<{ id: string }>();
  if (!device) return "unknown-workstation";
  const day = Math.floor(now / 86400);
  const id = `wake-${(await sha256Hex(`${tenantId}:${clientId}:${report.problem}:${day}`)).slice(0, 32)}`;
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO workstation_issues
         (id, tenant_id, client_id, severity, kind, image_version, details, occurred_at, created_at, report_state)
       VALUES (?, ?, ?, 'warning', 'wake_alarm', NULL, ?, ?, ?, 'none')`
    )
    .bind(id, tenantId, clientId, describePowerReport(report), now, now)
    .run();
  return result.meta.changes ? "recorded" : "duplicate";
}
