/**
 * Over-the-air releases (docs/OTA_UPDATES.md sections 5.3 to 5.7).
 *
 * CI signs each release and uploads it to the releases bucket as five files
 * under `releases/<version>/`. A super admin's Releases page finds them there,
 * records each one in `releases`, and classifies it `beta` or `stable`; until
 * then it reaches no workstation. An organization's workstations are offered
 * the newest unrevoked release of its channel (a `beta` organization also
 * takes `stable` ones), and download it from the bucket's public address.
 *
 * Nothing here decides whether an image is safe to boot: a workstation checks
 * the manifest's signature with the keys baked into its own image, refuses a
 * release below its security floor, and checks every chunk it downloads. The
 * Worker only chooses what to offer, so it parses a manifest to show it and to
 * order releases, never to vouch for it.
 */

import { Env, UpdateChannel } from "./types";
import { safeHttpUrl } from "./escape";

/** A release version, as labkiosk-boot-slots' VERSION_PATTERN accepts it. */
export const RELEASE_VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "beta"];
/** The files of one release, as build-iso.yml uploads them. */
export const RELEASE_FILES = ["vmlinuz", "initrd.img", "filesystem.squashfs", "manifest.json.sig", "manifest.json"] as const;
const RELEASE_PREFIX = "releases/";
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Releases looked at per sync: each new one is a manifest read from R2. */
const MAX_NEW_PER_SYNC = 50;

/** What a workstation says about the update it is fetching or holding. */
export const UPDATE_PHASES = ["live", "idle", "checking", "downloading", "ready", "installing", "up-to-date", "error"] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

export interface UpdateReport {
  phase: UpdatePhase;
  /** The release the phase is about (downloading, ready, installing). */
  version?: string;
  /** 0-100 while downloading. */
  progress?: number;
  /** Why the last attempt failed. */
  detail?: string;
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
}

/** The release offered to one organization, as a workstation fetches it. */
export interface ReleaseOffer {
  version: string;
  kind: "feature" | "security";
  sizeBytes: number;
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

/**
 * The parts of a manifest the console shows and the offer is ordered by.
 * Throws on anything that is not a manifest build-iso.yml would write.
 */
export function parseManifest(text: string): Omit<ReleaseSummary, "channel" | "foundAt" | "classifiedAt" | "revokedAt"> {
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
  return {
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
    revokedAt: row.revoked_at ?? null
  };
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

  const result: SyncResult = { added: [], problems: [] };
  for (const version of folders.slice(0, MAX_NEW_PER_SYNC)) {
    try {
      const object = await bucket.get(`${RELEASE_PREFIX}${version}/manifest.json`);
      if (!object) continue; // Still uploading: the manifest goes last.
      if (object.size > MAX_MANIFEST_BYTES) throw new Error("manifest.json is too large");
      const text = await object.text();
      const parsed = parseManifest(text);
      if (parsed.version !== version) throw new Error(`the folder ${version} holds the manifest of ${parsed.version}`);
      if (!(await bucket.head(`${RELEASE_PREFIX}${version}/manifest.json.sig`))) throw new Error("manifest.json.sig is missing");
      await db
        .prepare(
          `INSERT OR IGNORE INTO releases (version, channel, kind, base_version, security_floor, size_bytes, built_at, manifest, found_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(version, parsed.kind, parsed.baseVersion, parsed.securityFloor, parsed.sizeBytes, parsed.builtAt, text, now)
        .run();
      result.added.push(version);
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

/** Withdraw a release for good: no workstation is offered it again. */
export async function revokeRelease(db: D1Database, version: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const res = await db
    .prepare("UPDATE releases SET channel = NULL, revoked_at = ? WHERE version = ? AND revoked_at IS NULL")
    .bind(now, version)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}

/** The newest unrevoked release an organization on this channel is offered, or null. */
export async function offeredRelease(db: D1Database, channel: UpdateChannel | null | undefined): Promise<ReleaseOffer | null> {
  const channels = channel === "beta" ? ["stable", "beta"] : ["stable"];
  const res = await db
    .prepare(
      `SELECT version, kind, size_bytes FROM releases
       WHERE revoked_at IS NULL AND channel IN (${channels.map(() => "?").join(",")})`
    )
    .bind(...channels)
    .all<{ version: string; kind: "feature" | "security"; size_bytes: number }>();
  let best: ReleaseOffer | null = null;
  for (const row of res.results || []) {
    if (!isReleaseVersion(row.version)) continue;
    if (!best || compareVersions(row.version, best.version) > 0) {
      best = { version: row.version, kind: row.kind, sizeBytes: Number(row.size_bytes) || 0 };
    }
  }
  return best;
}

/**
 * The public folder a workstation downloads one release from, or null when the
 * platform has no release address configured. https only, except a local
 * development address; a workstation's updater checks the same.
 */
export function releaseFolderUrl(env: Env, version: string): string | null {
  const base = (env.RELEASES_BASE_URL || "").trim();
  if (!base || !isReleaseVersion(version)) return null;
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
  return `${validated.replace(/\/+$/, "")}/${RELEASE_PREFIX}${version}`;
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
  return report;
}

export function sameUpdateReport(a: UpdateReport | undefined, b: UpdateReport | undefined): boolean {
  if (!a || !b) return a === b;
  return a.phase === b.phase && a.version === b.version && a.progress === b.progress && a.detail === b.detail;
}
