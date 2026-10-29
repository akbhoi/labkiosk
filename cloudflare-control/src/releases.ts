/**
 * Over-the-air releases (docs/OTA_UPDATES.md sections 5.3 to 5.7).
 *
 * CI signs each release and uploads it to the releases bucket as five files
 * under `releases/<version>/`: the amd64 build, which every release has. A
 * build for another architecture is the same five files under
 * `releases/<version>/<architecture>/`, uploaded before amd64's manifest, and
 * goes only to the workstations of that architecture. A super admin's Releases page finds them there,
 * records each one in `releases`, and classifies a feature release `beta` or
 * `stable`; until then it reaches no workstation. An organization's
 * workstations are offered the newest unrevoked release of its channel (a
 * `beta` organization also takes `stable` ones), and download it from the
 * bucket's public address.
 *
 * Phase 4: a workstation is offered, before anything else, the newest
 * security release for the line it runs (2.8.1 for 2.8.0), which it installs
 * at its next boot by itself, as it does a minor release of its major
 * (installsByItself); a new major waits for its administrator. A security release
 * has no channel: it is offered from the moment it is recorded until it is
 * revoked, on every channel that offers a feature release of its line, and to
 * any workstation already on its line whatever its channel.
 *
 * The platform also keeps a support status per major release
 * (release_support) and decides which major releases a workstation may be
 * moved to (release_majors, major_upgrade_grants): an end-of-life major is
 * offered nothing, a security-only major only its security releases and only
 * to the workstations already on it, and a closed major only to an
 * organization it was opened or granted to and whose administrator confirmed it.
 *
 * The major upgrade pipeline: an administrator asks for a closed major
 * (requested), a super admin grants it (available) or declines, the
 * administrator tries it on one workstation group (pilot), then confirms it for
 * every workstation (confirmed). A workstation moves one major at a time, and
 * only from the newest release of the major it runs (eligibleReleases).
 *
 * Nothing here decides whether an image is safe to boot: a workstation checks
 * the manifest's signature with the keys baked into its own image, refuses a
 * release below its security floor, and checks every chunk it downloads. The
 * Worker only chooses what to offer, so it parses a manifest to show it and to
 * order releases, never to vouch for it.
 */

import { Env, UpdateChannel } from "./types";
import { safeHttpUrl } from "./escape";
import { activeOrganizationOwners, createNotification, emailOrganizations } from "./notifications";

/** A release version, as labkiosk-boot-slots' VERSION_PATTERN accepts it. */
export const RELEASE_VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "beta"];
/** The files of one release, as build-iso.yml uploads them. */
export const RELEASE_FILES = ["vmlinuz", "initrd.img", "filesystem.squashfs", "manifest.json.sig", "manifest.json"] as const;
const RELEASE_PREFIX = "releases/";
/** The architecture of `releases/<version>/` itself, and of every workstation that does not say. */
export const DEFAULT_ARCHITECTURE = "amd64";
/** A Debian architecture name, as labkiosk-update's ARCHITECTURE_PATTERN accepts it. */
export const ARCHITECTURE_PATTERN = /^[a-z0-9]{2,16}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Releases looked at per sync: each new one is a manifest read from R2. */
const MAX_NEW_PER_SYNC = 50;

/** What a workstation says about the update it is fetching or holding. */
export const UPDATE_PHASES = [
  "live",
  "idle",
  "checking",
  "downloading",
  "ready",
  "staged",
  "installing",
  "up-to-date",
  "error"
] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];
export type ReleaseKind = "feature" | "security";


export interface UpdateReport {
  phase: UpdatePhase;
  /** The release the phase is about (downloading, ready, staged, installing). */
  version?: string;
  /** 0-100 while downloading. */
  progress?: number;
  /** Why the last attempt failed. */
  detail?: string;
  /** The kind of the release it holds, from its signed manifest (ready, staged). */
  kind?: ReleaseKind;
  /** Unix seconds: since when it has held that release ready or staged, in this boot. */
  since?: number;
}

export interface ReleaseRow {
  version: string;
  channel: UpdateChannel | null;
  kind: "feature" | "security";
  base_version: string | null;
  security_floor: string;
  size_bytes: number;
  built_at: string;
  manifest: string;
  found_at: number;
  classified_at: number | null;
  classified_by: string | null;
  revoked_at: number | null;
  /** Comma-separated: the architectures the release has a signed build for. */
  architectures: string;
}

/** A release as the Releases page and a workstation see it. */
export interface ReleaseSummary {
  version: string;
  channel: UpdateChannel | null;
  kind: "feature" | "security";
  baseVersion: string | null;
  securityFloor: string;
  sizeBytes: number;
  builtAt: string;
  foundAt: number;
  classifiedAt: number | null;
  revokedAt: number | null;
  /** The architectures it has a signed build for, amd64 first. */
  architectures: string[];
}

/** The release offered to one organization, as a workstation fetches it. */
export interface ReleaseOffer {
  version: string;
  kind: ReleaseKind;
  sizeBytes: number;
  /** Unix seconds: when a super admin put it in its channel; for a security release, when it was recorded. */
  classifiedAt: number;
  /** The support status of its major now; absent means supported. */
  support?: SupportStatus;
  /** Its major is closed to this organization: only a workstation already on that major or above takes it. */
  gated?: boolean;
  /** Its major is gated, but this organization is trying it on the workstations of this group. */
  pilotGroup?: string;
  /**
   * A security release of a line this channel offers no feature release of:
   * offered only to a workstation already on its line, never to move one there.
   */
  lineOnly?: boolean;
  /** Its major is one this organization's administrator confirmed, or is trying on a workstation group. */
  approved?: boolean;
}

export const SUPPORT_STATUSES = ["supported", "security_only", "end_of_life"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export const MAX_RELEASE_MAJOR = 9999;

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === "string" && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

export function isReleaseMajor(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_RELEASE_MAJOR;
}

/** One major release's support status, as release_support holds it (0040). */
export interface MajorSupportRow {
  major: number;
  status: SupportStatus;
  end_of_life_at: number | null;
  note: string | null;
  updated_at: number;
  updated_by: string | null;
  /** The last end-of-life reminder sent for end_of_life_at: 60, 30, 7, or 0 once passed. */
  eol_reminder_days?: number | null;
}

/** A major's status now: an announced end-of-life date that has passed ends it. */
export function effectiveSupportStatus(row: Pick<MajorSupportRow, "status" | "end_of_life_at"> | undefined, now: number): SupportStatus {
  if (!row) return "supported";
  if (row.end_of_life_at && row.end_of_life_at <= now) return "end_of_life";
  return isSupportStatus(row.status) ? row.status : "supported";
}

/** What one workstation should fetch: a security release for its line, and the newest release. */
export interface WorkstationOffer {
  release: ReleaseOffer | null;
  security: ReleaseOffer | null;
}

type VersionKey = { core: number[]; pre: Array<[number, number, string]> | null };

function versionKey(version: string): VersionKey {
  if (!RELEASE_VERSION_PATTERN.test(version)) throw new Error(`${JSON.stringify(version)} is not a release version`);
  const dash = version.indexOf("-");
  const core = (dash < 0 ? version : version.slice(0, dash)).split(".").map(Number);
  if (dash < 0) return { core, pre: null };
  const pre = version
    .slice(dash + 1)
    .split(".")
    .map((part): [number, number, string] => {
      if (!part) throw new Error(`${JSON.stringify(version)} has an empty pre-release identifier`);
      return /^[0-9]+$/.test(part) ? [0, Number(part), ""] : [1, 0, part];
    });
  return { core, pre };
}

/**
 * Order versions as Semantic Versioning does -- 2.6.0-rc1 < 2.6.0 < 2.6.1 --
 * exactly as labkiosk-update's version_key() does, so the Worker and the
 * workstation agree on which release is newer.
 */
export function compareVersions(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka.core[i] !== kb.core[i]) return ka.core[i] < kb.core[i] ? -1 : 1;
  }
  if (!ka.pre || !kb.pre) {
    if (!ka.pre && !kb.pre) return 0;
    return ka.pre ? -1 : 1;
  }
  const n = Math.min(ka.pre.length, kb.pre.length);
  for (let i = 0; i < n; i++) {
    const [ta, na, sa] = ka.pre[i];
    const [tb, nb, sb] = kb.pre[i];
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (na !== nb) return na < nb ? -1 : 1;
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return ka.pre.length === kb.pre.length ? 0 : ka.pre.length < kb.pre.length ? -1 : 1;
}

export function isReleaseVersion(value: unknown): value is string {
  if (typeof value !== "string" || !RELEASE_VERSION_PATTERN.test(value)) return false;
  try {
    versionKey(value);
    return true;
  } catch {
    return false;
  }
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "beta";
}


/** The line a release belongs to: "2.8" for 2.8.1 and 2.8.0-rc1. */
export function releaseLine(version: string): string {
  const core = versionKey(version).core;
  return `${core[0]}.${core[1]}`;
}

/** The major release a version belongs to: 2 for 2.8.1. */
export function releaseMajor(version: string): number {
  return versionKey(version).core[0];
}

/** Every major's recorded support status, by major. */
export async function listMajorSupport(db: D1Database): Promise<Map<number, MajorSupportRow>> {
  const res = await db.prepare("SELECT * FROM release_support").all<MajorSupportRow>();
  return new Map((res.results || []).map((row) => [Number(row.major), { ...row, major: Number(row.major) }]));
}

/** Record a major's support status, end-of-life date and note. */
export async function setMajorSupport(
  db: D1Database,
  major: number,
  status: SupportStatus,
  endOfLifeAt: number | null,
  note: string | null,
  userId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (!isReleaseMajor(major)) throw new Error(`${JSON.stringify(major)} is not a major release`);
  await db
    .prepare(
      `INSERT INTO release_support (major, status, end_of_life_at, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(major) DO UPDATE SET status = excluded.status, end_of_life_at = excluded.end_of_life_at,
         note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
         -- A new end-of-life date starts its reminders over.
         eol_reminder_days = CASE WHEN release_support.end_of_life_at IS excluded.end_of_life_at
           THEN release_support.eol_reminder_days ELSE NULL END`
    )
    .bind(major, status, endOfLifeAt, note, now, userId)
    .run();
}

export async function listReleaseMajors(db: D1Database): Promise<Map<number, boolean>> {
  const res = await db.prepare("SELECT major, open FROM release_majors").all<{ major: number; open: number }>();
  return new Map((res.results || []).map((row) => [Number(row.major), Number(row.open) === 1]));
}

export async function setReleaseMajorOpen(
  db: D1Database,
  major: number,
  open: boolean,
  userId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO release_majors (major, open, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(major) DO UPDATE SET open = excluded.open, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    )
    .bind(major, open ? 1 : 0, now, userId)
    .run();
}

export interface MajorGrantRow {
  tenant_id: string;
  major: number;
  granted_by: string | null;
  granted_at: number | null;
  confirmed_by: string | null;
  confirmed_at: number | null;
  requested_by: string | null;
  requested_at: number | null;
  pilot_group: string | null;
  pilot_by: string | null;
  pilot_at: number | null;
}

/** One organization's major upgrade grants and confirmations, by major. */
export async function listMajorGrants(db: D1Database, tenantId: string): Promise<Map<number, MajorGrantRow>> {
  const res = await db.prepare("SELECT * FROM major_upgrade_grants WHERE tenant_id = ?").bind(tenantId).all<MajorGrantRow>();
  return new Map((res.results || []).map((row) => [Number(row.major), row]));
}

/** Every organization's grants and confirmations, for the platform's Releases page. */
export async function listAllMajorGrants(db: D1Database): Promise<MajorGrantRow[]> {
  return (await db.prepare("SELECT * FROM major_upgrade_grants ORDER BY major, tenant_id").all<MajorGrantRow>()).results || [];
}

/** Grant one organization a closed major, or take the grant back (and with it, its request, pilot and confirmation). */
export async function setMajorGrant(
  db: D1Database,
  tenantId: string,
  major: number,
  granted: boolean,
  userId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (granted) {
    await db
      .prepare(
        `INSERT INTO major_upgrade_grants (tenant_id, major, granted_by, granted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, major) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at`
      )
      .bind(tenantId, major, userId, now)
      .run();
  } else {
    await db.prepare("DELETE FROM major_upgrade_grants WHERE tenant_id = ? AND major = ?").bind(tenantId, major).run();
  }
}

/** An organization administrator's confirmation that its workstations may move to a major. */
export async function confirmMajor(
  db: D1Database,
  tenantId: string,
  major: number,
  userId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO major_upgrade_grants (tenant_id, major, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, major) DO UPDATE SET confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`
    )
    .bind(tenantId, major, userId, now)
    .run();
}

/** An organization administrator's request for a major closed to it. */
export async function requestMajor(
  db: D1Database,
  tenantId: string,
  major: number,
  userId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO major_upgrade_grants (tenant_id, major, requested_by, requested_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, major) DO UPDATE SET requested_by = excluded.requested_by, requested_at = excluded.requested_at`
    )
    .bind(tenantId, major, userId, now)
    .run();
}

/** A super admin's no to a request: the request is forgotten, so the organization may ask again. */
export async function declineMajorRequest(db: D1Database, tenantId: string, major: number): Promise<boolean> {
  const res = await db
    .prepare(
      `DELETE FROM major_upgrade_grants
       WHERE tenant_id = ? AND major = ? AND requested_at IS NOT NULL AND granted_at IS NULL AND confirmed_at IS NULL`
    )
    .bind(tenantId, major)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}

/** The workstation group an organization tries a major on before confirming it, or none (null). */
export async function setMajorPilot(
  db: D1Database,
  tenantId: string,
  major: number,
  group: string | null,
  userId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO major_upgrade_grants (tenant_id, major, pilot_group, pilot_by, pilot_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, major) DO UPDATE SET pilot_group = excluded.pilot_group, pilot_by = excluded.pilot_by, pilot_at = excluded.pilot_at`
    )
    .bind(tenantId, major, group, group === null ? null : userId, group === null ? null : now)
    .run();
}

/** Whether the organization is trying a major on a workstation group now. */
export async function hasMajorPilot(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM major_upgrade_grants WHERE tenant_id = ? AND pilot_group IS NOT NULL AND confirmed_at IS NULL LIMIT 1")
    .bind(tenantId)
    .first<{ one: number }>();
  return row !== null;
}

/** Ends every pilot whose workstation group no longer exists; how many it ended. */
export async function endOrphanedMajorPilots(db: D1Database, tenantId: string): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE major_upgrade_grants SET pilot_group = NULL, pilot_by = NULL, pilot_at = NULL
       WHERE tenant_id = ? AND pilot_group IS NOT NULL
         AND pilot_group NOT IN (SELECT name FROM workstation_groups WHERE tenant_id = ?)`
    )
    .bind(tenantId, tenantId)
    .run();
  return Number(res.meta?.changes ?? 0);
}

/** The workstation group of each of the organization's workstations in one of `groups`. */
export async function workstationGroupsIn(db: D1Database, tenantId: string, groups: readonly string[]): Promise<Map<string, string>> {
  if (!groups.length) return new Map();
  const res = await db
    .prepare(`SELECT client_id, group_name FROM client_devices WHERE tenant_id = ? AND group_name IN (${groups.map(() => "?").join(",")})`)
    .bind(tenantId, ...groups)
    .all<{ client_id: string; group_name: string }>();
  return new Map((res.results || []).map((row) => [row.client_id, row.group_name]));
}

/** Where one organization stands with one major. */
export type MajorAccess = "free" | "closed" | "requested" | "available" | "pilot" | "confirmed";

/**
 * free: no row, offered as before. closed: neither open nor granted to it.
 * requested: closed, and its administrator asked for it. available: open or
 * granted, waiting for its administrator. pilot: its administrator is trying it
 * on one workstation group. confirmed: its workstations may be moved to it.
 */
export function majorAccess(open: boolean | undefined, grant: MajorGrantRow | undefined): MajorAccess {
  if (open === undefined) return "free";
  if (!open && !grant?.granted_at) return grant?.requested_at ? "requested" : "closed";
  if (grant?.confirmed_at) return "confirmed";
  return grant?.pilot_group ? "pilot" : "available";
}

/** Whether a workstation of this organization needs the major confirmed (or piloted) before it is moved to it. */
function majorGated(access: MajorAccess): boolean {
  return access !== "free" && access !== "confirmed";
}

/**
 * The parts of a manifest the console shows and the offer is ordered by.
 * Throws on anything that is not a manifest build-iso.yml would write.
 */
export function parseManifest(
  text: string
): Omit<ReleaseSummary, "channel" | "foundAt" | "classifiedAt" | "revokedAt" | "architectures"> & { architecture: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("manifest.json is not an object");
  const m = raw as Record<string, unknown>;
  if (!isReleaseVersion(m.version)) throw new Error("manifest.json has no valid version");
  if (m.kind !== "feature" && m.kind !== "security") throw new Error("manifest.json has no valid kind");
  if (!isReleaseVersion(m.securityFloor)) throw new Error("manifest.json has no valid securityFloor");
  if (m.baseVersion !== null && m.baseVersion !== undefined && !isReleaseVersion(m.baseVersion)) {
    throw new Error("manifest.json has an invalid baseVersion");
  }
  if (typeof m.builtAt !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(m.builtAt)) {
    throw new Error("manifest.json has no valid builtAt");
  }
  if (!Array.isArray(m.files) || !m.files.length) throw new Error("manifest.json lists no files");
  let sizeBytes = 0;
  const names = new Set<string>();
  for (const entry of m.files) {
    const file = entry as Record<string, unknown> | null;
    const name = file && typeof file.name === "string" ? file.name : "";
    const size = file ? Number(file.size) : NaN;
    if (!["vmlinuz", "initrd.img", "filesystem.squashfs"].includes(name) || names.has(name)) {
      throw new Error("manifest.json lists an unexpected file");
    }
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`manifest.json gives ${name} no valid size`);
    names.add(name);
    sizeBytes += size;
  }
  if (names.size !== 3) throw new Error("manifest.json does not list the three image files");
  // An amd64 build leaves its architecture out, as every release before arm64 did.
  if (m.architecture !== undefined && (typeof m.architecture !== "string" || !ARCHITECTURE_PATTERN.test(m.architecture) || m.architecture === DEFAULT_ARCHITECTURE)) {
    throw new Error("manifest.json has an invalid architecture");
  }
  return {
    architecture: (m.architecture as string | undefined) ?? DEFAULT_ARCHITECTURE,
    version: m.version,
    kind: m.kind,
    baseVersion: (m.baseVersion as string | null | undefined) ?? null,
    securityFloor: m.securityFloor,
    sizeBytes,
    builtAt: m.builtAt
  };
}

export function summarize(row: ReleaseRow): ReleaseSummary {
  return {
    version: row.version,
    channel: row.channel,
    kind: row.kind,
    baseVersion: row.base_version,
    securityFloor: row.security_floor,
    sizeBytes: Number(row.size_bytes) || 0,
    builtAt: row.built_at,
    foundAt: Number(row.found_at) || 0,
    classifiedAt: row.classified_at ?? null,
    revokedAt: row.revoked_at ?? null,
    architectures: releaseArchitectures(row.architectures)
  };
}

/** The architectures column as a list, amd64 first; amd64 alone when it is empty. */
export function releaseArchitectures(column: string | null | undefined): string[] {
  const listed = (column || "").split(",").map((a) => a.trim()).filter((a) => ARCHITECTURE_PATTERN.test(a));
  const others = [...new Set(listed.filter((a) => a !== DEFAULT_ARCHITECTURE))].sort();
  return [DEFAULT_ARCHITECTURE, ...others];
}

/**
 * The builds of other architectures in a release's folder: each a folder
 * `releases/<version>/<architecture>/` whose signed manifest names that
 * architecture and that version. One that does not is an error, so a release
 * is never recorded with a build a workstation would refuse.
 */
async function otherArchitectures(bucket: R2Bucket, version: string): Promise<string[]> {
  const folder = `${RELEASE_PREFIX}${version}/`;
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: folder, delimiter: "/", cursor });
    for (const prefix of page.delimitedPrefixes) {
      const architecture = prefix.slice(folder.length).replace(/\/$/, "");
      if (!ARCHITECTURE_PATTERN.test(architecture) || architecture === DEFAULT_ARCHITECTURE) {
        throw new Error(`${prefix} is not the folder of an architecture's build`);
      }
      const object = await bucket.get(`${prefix}manifest.json`);
      if (!object) throw new Error(`the ${architecture} build has no manifest.json`);
      if (object.size > MAX_MANIFEST_BYTES) throw new Error(`the ${architecture} build's manifest.json is too large`);
      const parsed = parseManifest(await object.text());
      if (parsed.version !== version || parsed.architecture !== architecture) {
        throw new Error(`the ${architecture} folder holds the ${parsed.architecture} manifest of ${parsed.version}`);
      }
      if (!(await bucket.head(`${prefix}manifest.json.sig`))) throw new Error(`the ${architecture} build's manifest.json.sig is missing`);
      found.push(architecture);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found.sort();
}

/** Every release recorded, newest version first. */
export async function listReleases(db: D1Database): Promise<ReleaseSummary[]> {
  const res = await db.prepare("SELECT * FROM releases").all<ReleaseRow>();
  return (res.results || [])
    .filter((row) => isReleaseVersion(row.version))
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(summarize);
}

export async function findRelease(db: D1Database, version: string): Promise<ReleaseRow | null> {
  return db.prepare("SELECT * FROM releases WHERE version = ?").bind(version).first<ReleaseRow>();
}

export interface SyncResult {
  added: string[];
  /** The security releases among them: offered from now on, with no classification. */
  security: string[];
  problems: Array<{ version: string; problem: string }>;
}

/**
 * Record the releases in the bucket that are not recorded yet.
 *
 * A folder is a release once its manifest is there: build-iso.yml uploads the
 * manifest last, so the other files already are. A folder whose manifest does
 * not parse, names another version, or has no signature beside it is reported,
 * not recorded.
 */
export async function syncReleases(bucket: R2Bucket, db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<SyncResult> {
  const known = new Set(
    ((await db.prepare("SELECT version FROM releases").all<{ version: string }>()).results || []).map((r) => r.version)
  );
  const folders: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: RELEASE_PREFIX, delimiter: "/", cursor });
    for (const prefix of page.delimitedPrefixes) {
      const version = prefix.slice(RELEASE_PREFIX.length).replace(/\/$/, "");
      if (isReleaseVersion(version) && !known.has(version)) folders.push(version);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const result: SyncResult = { added: [], security: [], problems: [] };
  const majors = new Set([...known].filter(isReleaseVersion).map(releaseMajor));
  folders.sort(compareVersions);
  for (const version of folders.slice(0, MAX_NEW_PER_SYNC)) {
    try {
      const object = await bucket.get(`${RELEASE_PREFIX}${version}/manifest.json`);
      if (!object) continue; // Still uploading: the manifest goes last.
      if (object.size > MAX_MANIFEST_BYTES) throw new Error("manifest.json is too large");
      const text = await object.text();
      const parsed = parseManifest(text);
      if (parsed.version !== version) throw new Error(`the folder ${version} holds the manifest of ${parsed.version}`);
      if (parsed.architecture !== DEFAULT_ARCHITECTURE) throw new Error(`the folder ${version} holds a ${parsed.architecture} manifest, not amd64's`);
      if (!(await bucket.head(`${RELEASE_PREFIX}${version}/manifest.json.sig`))) throw new Error("manifest.json.sig is missing");
      // Uploaded before amd64's manifest, so they are all there by now.
      const architectures = [DEFAULT_ARCHITECTURE, ...(await otherArchitectures(bucket, version))].join(",");
      await db
        .prepare(
          `INSERT OR IGNORE INTO releases (version, channel, kind, base_version, security_floor, size_bytes, built_at, manifest, found_at, architectures)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(version, parsed.kind, parsed.baseVersion, parsed.securityFloor, parsed.sizeBytes, parsed.builtAt, text, now, architectures)
        .run();
      // The first release of a major above every one recorded starts closed:
      // no workstation is moved to it until a super admin opens or grants it.
      const major = releaseMajor(version);
      if (majors.size && major > Math.max(...majors)) {
        await db
          .prepare("INSERT OR IGNORE INTO release_majors (major, open, updated_at, updated_by) VALUES (?, 0, ?, NULL)")
          .bind(major, now)
          .run();
      }
      majors.add(major);
      result.added.push(version);
      if (parsed.kind === "security") result.security.push(version);
    } catch (err) {
      result.problems.push({ version, problem: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Put a release in a channel, or take it out (null). A revoked release stays revoked. */
export async function classifyRelease(
  db: D1Database,
  version: string,
  channel: UpdateChannel | null,
  userId: string,
  now = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE releases SET channel = ?, classified_at = ?, classified_by = ? WHERE version = ? AND revoked_at IS NULL")
    .bind(channel, channel ? now : null, channel ? userId : null, version)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}

/** Every unrevoked feature release classified stable, oldest first, for the daily security rebuild. */
export async function stableFeatureReleases(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare("SELECT version FROM releases WHERE revoked_at IS NULL AND channel = 'stable' AND kind = 'feature'")
    .all<{ version: string }>();
  return (res.results || [])
    .map((row) => row.version)
    .filter(isReleaseVersion)
    .sort(compareVersions);
}

/** Withdraw a release for good: no workstation is offered it again. */
export async function revokeRelease(db: D1Database, version: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const res = await db
    .prepare("UPDATE releases SET channel = NULL, revoked_at = ? WHERE version = ? AND revoked_at IS NULL")
    .bind(now, version)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}

/**
 * Every unrevoked release of this channel and every unrevoked security
 * release, newest first, each marked with its
 * major's support status now and whether its major is closed to the organization
 * (`tenantId`; null for none). Which of them one workstation may take is
 * eligibleReleases().
 */
export async function offeredReleases(
  db: D1Database,
  channel: UpdateChannel | null | undefined,
  tenantId: string | null,
  now = Math.floor(Date.now() / 1000),
  architecture: string = DEFAULT_ARCHITECTURE
): Promise<ReleaseOffer[]> {
  const channels = channel === "beta" ? ["stable", "beta"] : ["stable"];
  const [support, majors, grants] = await Promise.all([
    listMajorSupport(db),
    listReleaseMajors(db),
    tenantId ? listMajorGrants(db, tenantId) : Promise.resolve(new Map<number, MajorGrantRow>())
  ]);
  const res = await db
    .prepare(
      `SELECT version, kind, channel, size_bytes, classified_at, found_at, architectures FROM releases
       WHERE revoked_at IS NULL AND (kind = 'security' OR channel IN (${channels.map(() => "?").join(",")}))`
    )
    .bind(...channels)
    .all<{
      version: string;
      kind: ReleaseKind;
      channel: UpdateChannel | null;
      size_bytes: number;
      classified_at: number | null;
      found_at: number;
      architectures: string;
    }>();
  // Only the releases with a build for this architecture: an arm64 workstation
  // is never offered a release it would refuse.
  const rows = (res.results || []).filter(
    (row) => isReleaseVersion(row.version) && releaseArchitectures(row.architectures).includes(architecture)
  );
  // The lines this channel offers a feature release of: a security release of
  // any other line is offered only to the workstations already on it.
  const lines = new Set(
    rows.filter((row) => row.kind !== "security" && row.channel && channels.includes(row.channel)).map((row) => releaseLine(row.version))
  );
  return rows
    .map((row): ReleaseOffer => {
      const major = releaseMajor(row.version);
      const access = majorAccess(majors.get(major), grants.get(major));
      const status = effectiveSupportStatus(support.get(major), now);
      return {
        version: row.version,
        kind: row.kind,
        sizeBytes: Number(row.size_bytes) || 0,
        // A security release is offered from the moment it is recorded.
        classifiedAt: Number(row.kind === "security" ? row.found_at : row.classified_at) || 0,
        ...(status !== "supported" ? { support: status } : {}),
        ...(row.kind === "security" && !lines.has(releaseLine(row.version)) ? { lineOnly: true } : {}),
        ...(majorGated(access) ? { gated: true } : {}),
        ...(access === "pilot" ? { pilotGroup: grants.get(major)!.pilot_group! } : {}),
        ...(access === "confirmed" || access === "pilot" ? { approved: true } : {})
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The releases a workstation running `running`, in workstation group `group`,
 * may be moved to, newest first: nothing of an end-of-life major; of a
 * security-only major, only its security releases and only for a workstation
 * already on that major; nothing of a major closed to its organization above
 * the major it runs, unless the organization is trying that major on the
 * workstation's group. A workstation moves one major at a time, and only once
 * it runs the newest release of its own major it may take: 1.4 goes to 1.5
 * before 2.x, and 2.x before 3.x. A security release its channel offers only
 * on its own line (lineOnly) goes to a workstation already on that line alone.
 * An unknown image (an updater from before phase 4 does not say) is treated as
 * on no major.
 */
export function eligibleReleases(
  releases: readonly ReleaseOffer[],
  running: string | null | undefined,
  group: string | null = null
): ReleaseOffer[] {
  const known = isReleaseVersion(running);
  const major = known ? releaseMajor(running) : -1;
  const line = known ? releaseLine(running) : null;
  const supported = releases.filter((r) => {
    if (r.support === "end_of_life") return false;
    if (r.lineOnly && releaseLine(r.version) !== line) return false;
    return !(r.support === "security_only" && (r.kind !== "security" || releaseMajor(r.version) !== major));
  });
  const allowed = supported.filter(
    (r) => !(r.gated && releaseMajor(r.version) > major && !(r.pilotGroup && group !== null && r.pilotGroup === group))
  );
  if (!known) return allowed;
  // The next major is the lowest one above it that has a release it could take
  // once allowed: a gated major holds back every major above it as well.
  const newerInMajor = allowed.some((r) => releaseMajor(r.version) === major && compareVersions(r.version, running) > 0);
  const higher = supported.map((r) => releaseMajor(r.version)).filter((m) => m > major);
  const nextMajor = newerInMajor || !higher.length ? major : Math.min(...higher);
  return allowed.filter((r) => releaseMajor(r.version) <= nextMajor);
}

/** The newest release an organization offers a workstation that does not say what it runs, or null. */
export function newestOffered(releases: readonly ReleaseOffer[], group: string | null = null): ReleaseOffer | null {
  return eligibleReleases(releases, null, group)[0] ?? null;
}

/** Whether this channel has an unrevoked release of `major`, whoever it is offered to. */
export async function releaseOfMajorOffered(db: D1Database, channel: UpdateChannel | null | undefined, major: number): Promise<boolean> {
  return (await offeredReleases(db, channel, null)).some((r) => releaseMajor(r.version) === major);
}

/** The newest unrevoked release an organization on this channel offers any workstation, or null. */
export async function offeredRelease(
  db: D1Database,
  channel: UpdateChannel | null | undefined,
  tenantId: string
): Promise<ReleaseOffer | null> {
  return newestOffered(await offeredReleases(db, channel, tenantId));
}

/**
 * The newest security release for the line `running` belongs to and newer
 * than it, from releases sorted newest first; null for an unknown image.
 */
export function securityReleaseFor(
  releases: readonly ReleaseOffer[],
  running: string | null | undefined,
  group: string | null = null
): ReleaseOffer | null {
  if (!isReleaseVersion(running)) return null;
  const line = releaseLine(running);
  return (
    eligibleReleases(releases, running, group).find(
      (r) => r.kind === "security" && releaseLine(r.version) === line && compareVersions(r.version, running) > 0
    ) ?? null
  );
}

/**
 * Whether a workstation running `running` installs `release` at its next boot
 * without an administrator, once it holds it: always a security release for its
 * line and a minor release of its major, and a release of a higher major only
 * once an administrator confirmed that major (or is trying it on the
 * workstation's group). Anything else waits for Workstations -> Updates. The
 * workstation's updater checks the signed manifest's kind and line again
 * before it stages it.
 */
export function installsByItself(release: ReleaseOffer, running: string | null | undefined): boolean {
  if (!isReleaseVersion(running) || compareVersions(release.version, running) <= 0) return false;
  if (release.kind === "security") return releaseLine(release.version) === releaseLine(running);
  const major = releaseMajor(release.version);
  if (major === releaseMajor(running)) return true;
  return major > releaseMajor(running) && release.approved === true;
}

/** What a workstation running `running`, in workstation group `group`, is offered. */
export function workstationOffer(
  releases: readonly ReleaseOffer[],
  running: string | null | undefined,
  group: string | null = null
): WorkstationOffer {
  return { release: eligibleReleases(releases, running, group)[0] ?? null, security: securityReleaseFor(releases, running, group) };
}

/**
 * The release a workstation fetches next: a security release for its line
 * first (section 5.5: it never waits behind an unapproved feature release),
 * else the newest release when that is newer than what it runs; null when
 * there is nothing to fetch. labkiosk-update run chooses the same way.
 */
export function updateTargetFor(
  releases: readonly ReleaseOffer[],
  running: string | null | undefined,
  group: string | null = null
): ReleaseOffer | null {
  if (!isReleaseVersion(running)) return null;
  const { release, security } = workstationOffer(releases, running, group);
  const target = security ?? release;
  return target && compareVersions(target.version, running) > 0 ? target : null;
}

/** Days after which the console warns about a security release not yet running everywhere. */
export const SECURITY_WAIT_WARN_DAYS = 7;

/** A security release some of an organization's workstations on its line do not run yet. */
export interface PendingSecurityRelease {
  version: string;
  /** Unix seconds: since when it has been offered. */
  offeredAt: number;
  /** How many of the organization's workstations on its line run an older image. */
  workstations: number;
}

/**
 * For each line the organization's workstations run, the newest security
 * release offered for it and how many of them still run an older image there,
 * from releases sorted newest first and the organization's own registry rows.
 */
export function securityReleasesPending(
  releases: readonly ReleaseOffer[],
  devices: ReadonlyArray<{ image_version?: string | null; group_name?: string | null }>
): PendingSecurityRelease[] {
  const pending = new Map<string, PendingSecurityRelease>();
  for (const device of devices) {
    const security = securityReleaseFor(releases, device.image_version, device.group_name ?? null);
    if (!security) continue;
    const entry = pending.get(security.version) ?? { version: security.version, offeredAt: security.classifiedAt, workstations: 0 };
    entry.workstations++;
    pending.set(security.version, entry);
  }
  return [...pending.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The public folder a workstation downloads one release from, or null when the
 * platform has no release address configured. https only, except a local
 * development address; a workstation's updater checks the same.
 */
export function releaseFolderUrl(env: Env, version: string, architecture: string = DEFAULT_ARCHITECTURE): string | null {
  const base = (env.RELEASES_BASE_URL || "").trim();
  if (!base || !isReleaseVersion(version) || !ARCHITECTURE_PATTERN.test(architecture)) return null;
  const validated = safeHttpUrl(base);
  if (!validated) return null;
  let parsed: URL;
  try {
    parsed = new URL(validated);
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  if (parsed.protocol !== "https:" && !isLocalAddress(parsed.hostname)) return null;
  const folder = `${validated.replace(/\/+$/, "")}/${RELEASE_PREFIX}${version}`;
  return architecture === DEFAULT_ARCHITECTURE ? folder : `${folder}/${architecture}`;
}

/**
 * Whether RELEASES_BASE_URL is the bucket's r2.dev development address.
 * Cloudflare rate-limits it and does not cache it, so a fleet update through it
 * can be refused part-way and reads R2 once per workstation; a custom domain on
 * the bucket is cached at the edge.
 */
export function releaseAddressIsDevelopmentOnly(env: Env): boolean {
  const validated = safeHttpUrl((env.RELEASES_BASE_URL || "").trim());
  if (!validated) return false;
  try {
    const host = new URL(validated).hostname.toLowerCase();
    return host === "r2.dev" || host.endsWith(".r2.dev");
  } catch {
    return false;
  }
}

function isLocalAddress(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "host.docker.internal" ||
    host === "host.containers.internal" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
  );
}

/** A workstation's update report, validated; anything unusable is dropped. */
export function normalizeUpdateReport(raw: unknown): UpdateReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!UPDATE_PHASES.includes(r.phase as UpdatePhase)) return null;
  const report: UpdateReport = { phase: r.phase as UpdatePhase };
  if (isReleaseVersion(r.version)) report.version = r.version;
  const progress = Number(r.progress);
  if (r.progress !== undefined && r.progress !== null && Number.isFinite(progress)) {
    report.progress = Math.max(0, Math.min(100, Math.floor(progress)));
  }
  if (typeof r.detail === "string" && r.detail.trim()) report.detail = r.detail.trim().slice(0, 300);
  if (r.kind === "feature" || r.kind === "security") report.kind = r.kind;
  const since = Number(r.since);
  if (typeof r.since === "number" && Number.isSafeInteger(since) && since > 0) report.since = since;
  return report;
}

export function sameUpdateReport(a: UpdateReport | undefined, b: UpdateReport | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.phase === b.phase &&
    a.version === b.version &&
    a.progress === b.progress &&
    a.detail === b.detail &&
    a.kind === b.kind &&
    a.since === b.since
  );
}

/** A major some of an organization's workstations run that is not plainly supported. */
export interface SupportNotice {
  major: number;
  status: SupportStatus;
  /** Unix seconds: the announced end-of-life date, if any. */
  endOfLifeAt: number | null;
  note: string | null;
  workstations: number;
}

/** A major above what an organization's workstations run, and where the organization stands with it. */
export interface MajorNotice {
  major: number;
  access: Exclude<MajorAccess, "free">;
  /** The newest release of that major its channel offers. */
  newest: string;
  confirmedAt: number | null;
  requestedAt: number | null;
  /** The workstation group it is being tried on. */
  pilotGroup: string | null;
}

/**
 * What an organization's Updates settings warn about: the majors its
 * workstations run that are security-only, end of life or have an end-of-life
 * date, and the closed majors above the lowest one they run (every closed major
 * when none reports its image).
 */
export async function organizationReleaseNotices(
  db: D1Database,
  tenantId: string,
  releases: readonly ReleaseOffer[],
  devices: ReadonlyArray<{ image_version?: string | null }>,
  now = Math.floor(Date.now() / 1000)
): Promise<{ support: SupportNotice[]; majors: MajorNotice[] }> {
  const [rows, majors, grants] = await Promise.all([listMajorSupport(db), listReleaseMajors(db), listMajorGrants(db, tenantId)]);
  const perMajor = new Map<number, number>();
  for (const device of devices) {
    if (!isReleaseVersion(device.image_version)) continue;
    const major = releaseMajor(device.image_version);
    perMajor.set(major, (perMajor.get(major) ?? 0) + 1);
  }
  const lowestMajor = perMajor.size ? Math.min(...perMajor.keys()) : Infinity;
  const support: SupportNotice[] = [];
  for (const [major, workstations] of perMajor) {
    const row = rows.get(major);
    const status = effectiveSupportStatus(row, now);
    if (status === "supported" && !row?.end_of_life_at) continue;
    support.push({ major, status, endOfLifeAt: row?.end_of_life_at ?? null, note: row?.note ?? null, workstations });
  }
  support.sort((a, b) => a.major - b.major);
  const notices: MajorNotice[] = [];
  for (const release of releases) {
    const major = releaseMajor(release.version);
    if (Number.isFinite(lowestMajor) && major <= lowestMajor) continue;
    if (notices.some((n) => n.major === major)) continue;
    const access = majorAccess(majors.get(major), grants.get(major));
    if (access === "free") continue;
    if (release.support === "end_of_life" || release.support === "security_only") continue;
    const grant = grants.get(major);
    notices.push({
      major,
      access,
      newest: release.version,
      confirmedAt: grant?.confirmed_at ?? null,
      requestedAt: grant?.requested_at ?? null,
      pilotGroup: access === "pilot" ? grant?.pilot_group ?? null : null
    });
  }
  return { support, majors: notices };
}

/** How many workstations each organization and major has, across the platform, from the registry. */
export async function workstationsPerMajor(db: D1Database): Promise<Array<{ tenantId: string; major: number; workstations: number }>> {
  const res = await db
    .prepare("SELECT tenant_id, image_version, COUNT(*) AS n FROM client_devices WHERE image_version IS NOT NULL GROUP BY tenant_id, image_version")
    .all<{ tenant_id: string; image_version: string; n: number }>();
  const counts = new Map<string, { tenantId: string; major: number; workstations: number }>();
  for (const row of res.results || []) {
    if (!isReleaseVersion(row.image_version)) continue;
    const major = releaseMajor(row.image_version);
    const key = `${row.tenant_id}\n${major}`;
    const entry = counts.get(key) ?? { tenantId: row.tenant_id, major, workstations: 0 };
    entry.workstations += Number(row.n) || 0;
    counts.set(key, entry);
  }
  return [...counts.values()];
}

/** One major as the platform's Releases page shows it. */
export interface PlatformMajor {
  major: number;
  state: "free" | "open" | "closed";
  /** The support status a super admin set. */
  status: SupportStatus;
  /** What applies now, once an announced end-of-life date has passed. */
  effectiveStatus: SupportStatus;
  endOfLifeAt: number | null;
  note: string | null;
  workstations: number;
  organizations: number;
  grants: Array<{
    tenantId: string;
    name: string;
    requestedAt: number | null;
    grantedAt: number | null;
    pilotGroup: string | null;
    confirmedAt: number | null;
  }>;
}

/** Every major the platform has releases or settings for, newest first. */
export async function platformReleasePolicy(
  db: D1Database,
  releases: readonly ReleaseSummary[],
  tenantNames: ReadonlyMap<string, string>,
  now = Math.floor(Date.now() / 1000)
): Promise<{ majors: PlatformMajor[] }> {
  const [rows, majors, grants, usage] = await Promise.all([
    listMajorSupport(db),
    listReleaseMajors(db),
    listAllMajorGrants(db),
    workstationsPerMajor(db)
  ]);
  const majorNumbers = new Set<number>([...majors.keys(), ...rows.keys()]);
  for (const r of releases) majorNumbers.add(releaseMajor(r.version));
  const majorList = [...majorNumbers]
    .sort((a, b) => b - a)
    .map((major): PlatformMajor => {
      const open = majors.get(major);
      const row = rows.get(major);
      const using = usage.filter((u) => u.major === major);
      return {
        major,
        state: open === undefined ? "free" : open ? "open" : "closed",
        status: row && isSupportStatus(row.status) ? row.status : "supported",
        effectiveStatus: effectiveSupportStatus(row, now),
        endOfLifeAt: row?.end_of_life_at ?? null,
        note: row?.note ?? null,
        workstations: using.reduce((sum, u) => sum + u.workstations, 0),
        organizations: using.length,
        grants: grants
          .filter((g) => Number(g.major) === major)
          .map((g) => ({
            tenantId: g.tenant_id,
            name: tenantNames.get(g.tenant_id) ?? g.tenant_id,
            requestedAt: g.requested_at ?? null,
            grantedAt: g.granted_at ?? null,
            pilotGroup: g.confirmed_at ? null : g.pilot_group ?? null,
            confirmedAt: g.confirmed_at ?? null
          }))
      };
    });
  return { majors: majorList };
}

/** Days before a major's end-of-life date that every organization is reminded. */
export const END_OF_LIFE_REMINDER_DAYS = [60, 30, 7] as const;

/**
 * Which reminder a major's end-of-life date calls for now: 60, 30 or 7 (days
 * before), 0 once the date has passed, or null when it is further off.
 */
export function endOfLifeReminderStage(endOfLifeAt: number, now = Math.floor(Date.now() / 1000)): number | null {
  if (endOfLifeAt <= now) return 0;
  const daysLeft = Math.ceil((endOfLifeAt - now) / 86_400);
  const due = END_OF_LIFE_REMINDER_DAYS.filter((days) => daysLeft <= days);
  return due.length ? Math.min(...due) : null;
}

/** What organizations are told about a major's support status: a title and a message. */
export function majorSupportNotice(
  major: number,
  status: SupportStatus,
  endOfLifeAt: number | null,
  note: string | null,
  options: { reminder?: boolean; now?: number } = {}
): { title: string; body: string } {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const name = `Lab Kiosk ${major}`;
  const date = endOfLifeAt !== null ? new Date(endOfLifeAt * 1000).toISOString().slice(0, 10) : null;
  let title: string;
  let body: string;
  if (status === "end_of_life" || (endOfLifeAt !== null && endOfLifeAt <= now)) {
    title = `${name} has reached end of life`;
    body =
      `${name} has reached end of life. Workstations on it receive no further updates, security fixes included. ` +
      `Install the newest supported release from Workstations → Updates to keep receiving them.`;
  } else if (date) {
    title = `${options.reminder ? "Reminder: " : ""}${name} reaches end of life on ${date}`;
    body =
      `${name} reaches end of life on ${date}. After that date workstations on it receive no further updates, security fixes included.` +
      (status === "security_only" ? ` Until then it receives security fixes only.` : "") +
      ` Move your workstations to a newer release before then from Workstations → Updates.`;
  } else {
    title = `${name} now receives security fixes only`;
    body =
      `${name} now receives security fixes only: no workstation is moved onto it, and workstations on it get only its security releases. ` +
      `Move your workstations to a newer release from Workstations → Updates.`;
  }
  return { title, body: note ? `${body}\n\n${note}` : body };
}

/** Record which end-of-life reminder a major has had for its current date. */
export async function setEndOfLifeReminderStage(db: D1Database, major: number, stage: number | null): Promise<void> {
  await db.prepare("UPDATE release_support SET eol_reminder_days = ? WHERE major = ?").bind(stage, major).run();
}

/**
 * The end-of-life reminders now due (hourly, from the cron): for each major with
 * an end-of-life date, the first time it comes within 60, 30 and 7 days and the
 * first time it has passed, every organization gets a console notification and
 * its owner an email. Returns the majors reminded about.
 */
export async function sendEndOfLifeReminders(
  env: Env,
  db: D1Database,
  now = Math.floor(Date.now() / 1000)
): Promise<number[]> {
  const reminded: number[] = [];
  for (const row of (await listMajorSupport(db)).values()) {
    if (row.end_of_life_at === null || row.end_of_life_at === undefined || row.status === "end_of_life") continue;
    const endOfLifeAt = Number(row.end_of_life_at);
    const stage = endOfLifeReminderStage(endOfLifeAt, now);
    const last = row.eol_reminder_days === null || row.eol_reminder_days === undefined ? null : Number(row.eol_reminder_days);
    if (stage === null || (last !== null && stage >= last)) continue;
    const notice = majorSupportNotice(row.major, row.status, endOfLifeAt, row.note ?? null, { reminder: stage > 0, now });
    // Recorded first: a failure part-way never repeats the reminder every hour.
    await setEndOfLifeReminderStage(db, row.major, stage);
    await createNotification(db, { tenantId: null, kind: "release", title: notice.title, body: notice.body, createdBy: null, now });
    const outcome = await emailOrganizations(env, await activeOrganizationOwners(db, null), notice.title, () => notice.body);
    if (outcome.emailProblem) console.warn(`[Worker] End-of-life reminder for ${row.major}: ${outcome.emailProblem}`);
    reminded.push(row.major);
  }
  return reminded;
}
