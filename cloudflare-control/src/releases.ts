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
 * Phase 4: a workstation is offered, before anything else, the newest
 * security release for the line it runs (2.8.1 for 2.8.0), and its
 * organization's `security_updates` setting says whether it installs that at
 * its next boot by itself or waits for an administrator.
 *
 * Nothing here decides whether an image is safe to boot: a workstation checks
 * the manifest's signature with the keys baked into its own image, refuses a
 * release below its security floor, and checks every chunk it downloads. The
 * Worker only chooses what to offer, so it parses a manifest to show it and to
 * order releases, never to vouch for it.
 */

import { Env, SecurityUpdateMode, UpdateChannel } from "./types";
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

export const SECURITY_UPDATE_MODES: readonly SecurityUpdateMode[] = ["next_boot", "approval"];

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
  kind: ReleaseKind;
  sizeBytes: number;
  /** Unix seconds: when a super admin put it in its channel. */
  classifiedAt: number;
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

export function isSecurityUpdateMode(value: unknown): value is SecurityUpdateMode {
  return value === "next_boot" || value === "approval";
}

/** The line a release belongs to: "2.8" for 2.8.1 and 2.8.0-rc1. */
export function releaseLine(version: string): string {
  const core = versionKey(version).core;
  return `${core[0]}.${core[1]}`;
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

/** Every unrevoked release an organization on this channel is offered, newest first. */
export async function offeredReleases(db: D1Database, channel: UpdateChannel | null | undefined): Promise<ReleaseOffer[]> {
  const channels = channel === "beta" ? ["stable", "beta"] : ["stable"];
  const res = await db
    .prepare(
      `SELECT version, kind, size_bytes, classified_at FROM releases
       WHERE revoked_at IS NULL AND channel IN (${channels.map(() => "?").join(",")})`
    )
    .bind(...channels)
    .all<{ version: string; kind: ReleaseKind; size_bytes: number; classified_at: number | null }>();
  return (res.results || [])
    .filter((row) => isReleaseVersion(row.version))
    .map((row) => ({
      version: row.version,
      kind: row.kind,
      sizeBytes: Number(row.size_bytes) || 0,
      classifiedAt: Number(row.classified_at) || 0
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest unrevoked release an organization on this channel is offered, or null. */
export async function offeredRelease(db: D1Database, channel: UpdateChannel | null | undefined): Promise<ReleaseOffer | null> {
  return (await offeredReleases(db, channel))[0] ?? null;
}

/**
 * The newest security release for the line `running` belongs to and newer
 * than it, from releases sorted newest first; null for an unknown image.
 */
export function securityReleaseFor(releases: readonly ReleaseOffer[], running: string | null | undefined): ReleaseOffer | null {
  if (!isReleaseVersion(running)) return null;
  const line = releaseLine(running);
  return (
    releases.find(
      (r) => r.kind === "security" && releaseLine(r.version) === line && compareVersions(r.version, running) > 0
    ) ?? null
  );
}

/** What a workstation running `running` is offered. */
export function workstationOffer(releases: readonly ReleaseOffer[], running: string | null | undefined): WorkstationOffer {
  return { release: releases[0] ?? null, security: securityReleaseFor(releases, running) };
}

/**
 * The release a workstation fetches next: a security release for its line
 * first (section 5.5: it never waits behind an unapproved feature release),
 * else the newest release when that is newer than what it runs; null when
 * there is nothing to fetch. labkiosk-update run chooses the same way.
 */
export function updateTargetFor(releases: readonly ReleaseOffer[], running: string | null | undefined): ReleaseOffer | null {
  if (!isReleaseVersion(running)) return null;
  const { release, security } = workstationOffer(releases, running);
  const target = security ?? release;
  return target && compareVersions(target.version, running) > 0 ? target : null;
}

/** Days after which the console warns about a security release not yet running everywhere. */
export const SECURITY_WAIT_WARN_DAYS = 7;

/** A security release some of an organization's workstations on its line do not run yet. */
export interface PendingSecurityRelease {
  version: string;
  /** Unix seconds: when it was put in its channel. */
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
  devices: ReadonlyArray<{ image_version?: string | null }>
): PendingSecurityRelease[] {
  const pending = new Map<string, PendingSecurityRelease>();
  for (const device of devices) {
    const security = securityReleaseFor(releases, device.image_version);
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
