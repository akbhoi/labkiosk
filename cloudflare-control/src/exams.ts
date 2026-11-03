/**
 * Exam mode: a timed window in which an organization's workstations, or one
 * group of them, are held on an exam site.
 *
 * While an exam runs, each workstation it covers is told (src/org_hub.ts,
 * configFor) to show the exam's address as a broadcast, to allow only the exam's
 * sites, not to print, and to keep Home on the exam instead of starting over. It
 * cannot be sent anywhere else: a broadcast to it is refused (index.ts,
 * /api/command). At the start and at the end its browser session is cleared,
 * which also empties the clipboard, and at the end it is sent back to its portal.
 * Downloads, file pickers and file:// are blocked on every kiosk all the time
 * (usr/share/labkiosk/chromium-policy-base.json), so USB storage is unreachable
 * from the browser with or without an exam.
 *
 * The organization's hub drives the start and the end with its alarm, and
 * records each covered workstation's connections and disconnections during the
 * window in `exam_events`, from which the live board and the report are drawn.
 * Exams and their events are kept EXAM_RETENTION_DAYS after they end.
 */

import { normalizeDomain, setClientsBroadcast, updateTenant } from "./db";
import { safeHttpUrl } from "./escape";

export const EXAM_LIMITS = {
  title: 120,
  extraHosts: 20,
  minMinutes: 5,
  maxMinutes: 600,
  /** How far ahead an exam can be scheduled. */
  aheadDays: 90,
  /** Exams scheduled or running at once, per organization. */
  open: 50
} as const;
export const EXAM_RETENTION_DAYS = 90;
/** A start this far in the past is taken as "now"; further back is refused. */
const START_GRACE_SECONDS = 120;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface ExamRow {
  id: string;
  tenant_id: string;
  title: string;
  group_name: string | null;
  exam_url: string;
  /** JSON array of hostnames, the exam address's own first. */
  allowed_hosts: string;
  starts_at: number;
  ends_at: number;
  ended_at: number | null;
  finalized_at: number | null;
  created_by: string | null;
  ended_by: string | null;
  created_at: number;
}

export type ExamPhase = "scheduled" | "running" | "ended";

/** What the hub and the console need of an exam. */
export interface ExamWindow {
  id: string;
  title: string;
  groupName: string | null;
  url: string;
  hosts: string[];
  startsAt: number;
  /** When it ends or ended: the scheduled end, or earlier when ended by hand. */
  endsAt: number;
  /** Ended before it started: it never ran. */
  cancelled: boolean;
}

export interface ExamInput {
  title: string;
  groupName: string | null;
  url: string;
  hosts: string[];
  startsAt: number;
  endsAt: number;
}

export function examEnd(row: Pick<ExamRow, "ends_at" | "ended_at">): number {
  return row.ended_at === null ? row.ends_at : Math.min(row.ended_at, row.ends_at);
}

export function examPhase(row: Pick<ExamRow, "starts_at" | "ends_at" | "ended_at">, nowSeconds: number): ExamPhase {
  if (nowSeconds >= examEnd(row)) return "ended";
  return nowSeconds >= row.starts_at ? "running" : "scheduled";
}

function parseHosts(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string" && HOST_PATTERN.test(h)) : [];
  } catch (err) {
    console.error("[Exams] Unreadable allowed_hosts:", raw, err);
    return [];
  }
}

export function examWindow(row: ExamRow): ExamWindow {
  const endsAt = examEnd(row);
  return {
    id: row.id,
    title: row.title,
    groupName: row.group_name,
    url: row.exam_url,
    hosts: parseHosts(row.allowed_hosts),
    startsAt: row.starts_at,
    endsAt,
    cancelled: row.ended_at !== null && row.ended_at < row.starts_at
  };
}

/**
 * The broadcast epoch an exam is shown with. Epochs are the millisecond an
 * operator sent a broadcast (index.ts, /api/command), and a workstation follows
 * only a newer one; the last millisecond of the start's second keeps a broadcast
 * sent in that same second from outranking the exam.
 */
export function examEpoch(startsAt: number): number {
  return startsAt * 1000 + 999;
}

/** Whether an exam covers a workstation in this group (undefined: in no group). */
export function examCovers(exam: Pick<ExamWindow, "groupName">, groupName: string | undefined): boolean {
  return exam.groupName === null || exam.groupName === groupName;
}

/** Validate a new exam. `groups` are the organization's workstation group names. */
export function parseExamInput(
  body: unknown,
  groups: readonly string[],
  nowSeconds: number
): { ok: true; value: ExamInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "The request body must be an object" };
  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return { ok: false, error: "Give the exam a name" };
  if (title.length > EXAM_LIMITS.title) return { ok: false, error: `The name is at most ${EXAM_LIMITS.title} characters` };

  const url = safeHttpUrl(typeof b.url === "string" ? b.url.trim() : "");
  if (!url) return { ok: false, error: "The exam address must be a full http(s) address, such as https://exam.example.org/test" };
  const ownHost = new URL(url).hostname.toLowerCase();
  if (!HOST_PATTERN.test(ownHost)) return { ok: false, error: "The exam address must be on a named site, not an IP address" };

  const rawHosts = b.hosts === undefined || b.hosts === null ? [] : b.hosts;
  if (!Array.isArray(rawHosts)) return { ok: false, error: "Other sites are a list of domain names" };
  const extra: string[] = [];
  for (const raw of rawHosts) {
    if (typeof raw !== "string") return { ok: false, error: "Other sites are a list of domain names" };
    const host = normalizeDomain(raw);
    if (!host) continue;
    if (!HOST_PATTERN.test(host)) return { ok: false, error: `"${raw.slice(0, 80)}" is not a domain name` };
    if (host !== ownHost && !extra.includes(host)) extra.push(host);
  }
  if (extra.length > EXAM_LIMITS.extraHosts) return { ok: false, error: `At most ${EXAM_LIMITS.extraHosts} other sites` };

  let groupName: string | null = null;
  if (b.groupName !== undefined && b.groupName !== null && b.groupName !== "") {
    if (typeof b.groupName !== "string" || !groups.includes(b.groupName)) return { ok: false, error: "Workstation group not found" };
    groupName = b.groupName;
  }

  let startsAt = nowSeconds;
  if (b.startsAt !== undefined && b.startsAt !== null) {
    if (typeof b.startsAt !== "number" || !Number.isInteger(b.startsAt)) return { ok: false, error: "The start is a time in seconds" };
    if (b.startsAt < nowSeconds - START_GRACE_SECONDS) return { ok: false, error: "The start time has already passed" };
    if (b.startsAt > nowSeconds + EXAM_LIMITS.aheadDays * 86400) {
      return { ok: false, error: `An exam can be scheduled at most ${EXAM_LIMITS.aheadDays} days ahead` };
    }
    startsAt = Math.max(b.startsAt, nowSeconds);
  }
  const minutes = b.durationMinutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < EXAM_LIMITS.minMinutes || minutes > EXAM_LIMITS.maxMinutes) {
    return { ok: false, error: `The length is ${EXAM_LIMITS.minMinutes} to ${EXAM_LIMITS.maxMinutes} minutes` };
  }
  return { ok: true, value: { title, groupName, url, hosts: [ownHost, ...extra], startsAt, endsAt: startsAt + minutes * 60 } };
}

/** Exams not yet ended, for the overlap and limit checks. */
async function openExams(db: D1Database, tenantId: string, nowSeconds: number): Promise<ExamRow[]> {
  const res = await db
    .prepare("SELECT * FROM exam_sessions WHERE tenant_id = ? AND ends_at > ? AND (ended_at IS NULL OR ended_at > ?)")
    .bind(tenantId, nowSeconds, nowSeconds)
    .all<ExamRow>();
  return res.results ?? [];
}

/** Save a new exam. Two exams never cover the same workstation at the same time. */
export async function createExam(
  db: D1Database,
  tenantId: string,
  input: ExamInput,
  userId: string | null,
  nowSeconds: number
): Promise<{ ok: true; id: string } | { ok: false; error: string; status: number }> {
  const open = await openExams(db, tenantId, nowSeconds);
  if (open.length >= EXAM_LIMITS.open) return { ok: false, error: `At most ${EXAM_LIMITS.open} exams can be scheduled at once`, status: 409 };
  const clash = open.find(
    (e) =>
      e.starts_at < input.endsAt &&
      examEnd(e) > input.startsAt &&
      (e.group_name === null || input.groupName === null || e.group_name === input.groupName)
  );
  if (clash) {
    return {
      ok: false,
      error: `This overlaps "${clash.title}" on ${clash.group_name ? `the ${clash.group_name} group` : "all workstations"}. Pick another time or group.`,
      status: 409
    };
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO exam_sessions (id, tenant_id, title, group_name, exam_url, allowed_hosts, starts_at, ends_at, ended_at, finalized_at, created_by, ended_by, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)"
    )
    .bind(id, tenantId, input.title, input.groupName, input.url, JSON.stringify(input.hosts), input.startsAt, input.endsAt, userId, nowSeconds)
    .run();
  return { ok: true, id };
}

export async function findExam(db: D1Database, tenantId: string, id: string): Promise<ExamRow | null> {
  return db.prepare("SELECT * FROM exam_sessions WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<ExamRow>();
}

/** Exams scheduled, running, or ended in the last EXAM_RETENTION_DAYS, the latest start first. */
export async function listExams(db: D1Database, tenantId: string): Promise<ExamRow[]> {
  const res = await db
    .prepare("SELECT * FROM exam_sessions WHERE tenant_id = ? ORDER BY starts_at DESC LIMIT 200")
    .bind(tenantId)
    .all<ExamRow>();
  return res.results ?? [];
}

/** What the hub keeps in view: every exam not yet ended, and those ended in the last day. */
export async function hubExams(db: D1Database, tenantId: string, nowSeconds: number): Promise<ExamWindow[]> {
  const res = await db
    .prepare("SELECT * FROM exam_sessions WHERE tenant_id = ? AND COALESCE(MIN(ended_at, ends_at), ends_at) > ? ORDER BY starts_at")
    .bind(tenantId, nowSeconds - 86400)
    .all<ExamRow>();
  return (res.results ?? []).map(examWindow);
}

/** End an exam now, or cancel one that has not started. */
export async function endExam(
  db: D1Database,
  tenantId: string,
  id: string,
  userId: string | null,
  nowSeconds: number
): Promise<{ ok: true; exam: ExamRow } | { ok: false; error: string; status: number }> {
  const exam = await findExam(db, tenantId, id);
  if (!exam) return { ok: false, error: "Exam not found", status: 404 };
  if (examPhase(exam, nowSeconds) === "ended") return { ok: false, error: "This exam has already ended", status: 409 };
  await db.prepare("UPDATE exam_sessions SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL").bind(nowSeconds, userId, id).run();
  return { ok: true, exam: { ...exam, ended_at: nowSeconds, ended_by: userId } };
}

/** The workstations an exam covers, as the registry has them now. */
export async function examClients(db: D1Database, tenantId: string, groupName: string | null): Promise<Array<{ client_id: string; group_name: string | null }>> {
  const res = groupName === null
    ? await db.prepare("SELECT client_id, group_name FROM client_devices WHERE tenant_id = ? ORDER BY client_id").bind(tenantId).all<{ client_id: string; group_name: string | null }>()
    : await db
        .prepare("SELECT client_id, group_name FROM client_devices WHERE tenant_id = ? AND group_name = ? ORDER BY client_id")
        .bind(tenantId, groupName)
        .all<{ client_id: string; group_name: string | null }>();
  return res.results ?? [];
}

/**
 * After an exam that ran, send its workstations back to their portal: recorded
 * as a reset (no URL) newer than the exam's broadcast, exactly as an operator's
 * "Reset to portal" is. Once per exam, whoever gets there first: the hub's alarm
 * at the end, or the route that ends it early. False when it was already done.
 */
export async function finishExam(db: D1Database, exam: ExamWindow, nowMs: number): Promise<boolean> {
  // Newer than the exam's own epoch even when it ends in the second it started.
  const atMs = Math.max(nowMs, examEpoch(exam.startsAt) + 1);
  const res = await db
    .prepare("UPDATE exam_sessions SET finalized_at = ? WHERE id = ? AND finalized_at IS NULL")
    .bind(Math.floor(atMs / 1000), exam.id)
    .run();
  if (!res.meta.changes) return false;
  if (exam.cancelled) return true;
  const row = await db.prepare("SELECT tenant_id FROM exam_sessions WHERE id = ?").bind(exam.id).first<{ tenant_id: string }>();
  if (!row) return false;
  if (exam.groupName === null) {
    await updateTenant(db, row.tenant_id, { broadcast_url: null, broadcast_epoch: atMs });
  } else {
    const clients = (await examClients(db, row.tenant_id, exam.groupName)).map((c) => c.client_id);
    for (let i = 0; i < clients.length; i += 90) await setClientsBroadcast(db, row.tenant_id, clients.slice(i, i + 90), null, atMs);
  }
  return true;
}

export type ExamEvent = "start-online" | "start-offline" | "connect" | "disconnect";

export async function recordExamEvents(
  db: D1Database,
  examId: string,
  events: Array<{ clientId: string; event: ExamEvent; at: number }>
): Promise<void> {
  if (!events.length) return;
  await db.batch(
    events.map((e) =>
      db.prepare("INSERT INTO exam_events (exam_id, client_id, event, at) VALUES (?, ?, ?, ?)").bind(examId, e.clientId, e.event, e.at)
    )
  );
}

export interface ExamWorkstation {
  clientId: string;
  groupName: string | null;
  /** null: it was not checked at the start (it joined the group later, or the exam has not started). */
  onlineAtStart: boolean | null;
  disconnections: number;
  offlineSeconds: number;
}

/**
 * Each covered workstation's exam so far: whether it was online at the start,
 * how often it dropped off, and for how long in all, up to the end or now.
 */
export async function examWorkstations(db: D1Database, exam: ExamRow, nowSeconds: number): Promise<ExamWorkstation[]> {
  const window = examWindow(exam);
  const [clients, events] = await Promise.all([
    examClients(db, exam.tenant_id, exam.group_name),
    db
      .prepare("SELECT client_id, event, at FROM exam_events WHERE exam_id = ? ORDER BY at, id")
      .bind(exam.id)
      .all<{ client_id: string; event: ExamEvent; at: number }>()
  ]);
  const groups = new Map(clients.map((c) => [c.client_id, c.group_name]));
  const byClient = new Map<string, Array<{ event: ExamEvent; at: number }>>();
  for (const e of events.results ?? []) {
    if (!groups.has(e.client_id)) groups.set(e.client_id, exam.group_name);
    const list = byClient.get(e.client_id) ?? [];
    list.push({ event: e.event, at: e.at });
    byClient.set(e.client_id, list);
  }
  const started = nowSeconds >= window.startsAt && !window.cancelled;
  const until = Math.min(window.endsAt, nowSeconds);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([clientId, groupName]) => {
      const list = byClient.get(clientId) ?? [];
      const snapshot = list.find((e) => e.event === "start-online" || e.event === "start-offline");
      const onlineAtStart = snapshot ? snapshot.event === "start-online" : null;
      let online = onlineAtStart === true;
      let offlineSince = window.startsAt;
      let offlineSeconds = 0;
      let disconnections = 0;
      for (const e of list) {
        if (e.event === "connect" && !online) {
          offlineSeconds += Math.max(0, e.at - offlineSince);
          online = true;
        } else if (e.event === "disconnect" && online) {
          disconnections += 1;
          online = false;
          offlineSince = e.at;
        }
      }
      if (started && !online) offlineSeconds += Math.max(0, until - offlineSince);
      return { clientId, groupName, onlineAtStart, disconnections, offlineSeconds: started ? offlineSeconds : 0 };
    });
}

function csvField(value: string): string {
  // A leading = + - @ makes a spreadsheet run the cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function utcText(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** The report a teacher downloads: one row per workstation. */
export function examReportCsv(exam: ExamRow, rows: ExamWorkstation[]): string {
  const window = examWindow(exam);
  const lines = [
    ["Exam", exam.title],
    ["Workstations", exam.group_name ? `Group ${exam.group_name}` : "All"],
    ["Started", window.cancelled ? "Cancelled before it started" : utcText(window.startsAt)],
    ["Ended", utcText(window.endsAt)],
    [],
    ["Workstation", "Group", "Online at start", "Disconnections", "Minutes offline"],
    ...rows.map((r) => [
      r.clientId,
      r.groupName ?? "",
      r.onlineAtStart === null ? "Not checked" : r.onlineAtStart ? "Yes" : "No",
      String(r.disconnections),
      String(Math.round(r.offlineSeconds / 60))
    ])
  ];
  return lines.map((cells) => cells.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/**
 * Why a broadcast to these targets is refused: an exam is running on some of them.
 */
export async function examBlockingBroadcast(
  db: D1Database,
  tenantId: string,
  targets: readonly string[],
  nowSeconds: number
): Promise<string | null> {
  const running = (await openExams(db, tenantId, nowSeconds)).filter((e) => e.starts_at <= nowSeconds);
  if (!running.length) return null;
  const everyone = running.find((e) => e.group_name === null);
  if (everyone || targets.includes("all")) {
    const exam = everyone ?? running[0];
    return `"${exam.title}" is running on ${exam.group_name ? `the ${exam.group_name} group` : "all workstations"}. End it on the Exams page first, or send to workstations outside it.`;
  }
  const named = targets.filter((t) => t !== "all");
  if (!named.length) return null;
  const rows = await db
    .prepare(`SELECT client_id, group_name FROM client_devices WHERE tenant_id = ? AND client_id IN (${named.map(() => "?").join(",")})`)
    .bind(tenantId, ...named)
    .all<{ client_id: string; group_name: string | null }>();
  for (const row of rows.results ?? []) {
    const exam = running.find((e) => e.group_name === row.group_name);
    if (exam) return `${row.client_id} is in "${exam.title}", which is running. End the exam on the Exams page first, or leave it out.`;
  }
  return null;
}

/** Exams that ended more than EXAM_RETENTION_DAYS ago, with their events. */
export async function purgeOldExams(db: D1Database, nowSeconds: number): Promise<number> {
  const cutoff = nowSeconds - EXAM_RETENTION_DAYS * 86400;
  const old = "SELECT id FROM exam_sessions WHERE COALESCE(MIN(ended_at, ends_at), ends_at) < ?";
  const [, sessions] = await db.batch([
    db.prepare(`DELETE FROM exam_events WHERE exam_id IN (${old})`).bind(cutoff),
    db.prepare("DELETE FROM exam_sessions WHERE COALESCE(MIN(ended_at, ends_at), ends_at) < ?").bind(cutoff)
  ]);
  return sessions.meta.changes ?? 0;
}
