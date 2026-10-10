/**
 * Over-the-air updates, phase 5: sharing a release on the local network
 * (docs/OTA_UPDATES.md section 5.9).
 *
 * A site is the workstations of one organization that reach the Worker from the
 * same public address and report an address in the same private LAN subnet. When
 * the organization turns sharing on (`tenants.lan_sharing`), the first workstations
 * of a site to hear of a release (the seeds) fetch it from the internet, the rest
 * wait, and each then copies it from a site member that holds it verified. Every
 * file a peer serves is checked against the signed manifest, so a peer can waste
 * a workstation's time but never change what it installs; and a workstation never
 * waits on the LAN for long before it fetches the release from the internet itself.
 *
 * Who is where is live state: OrgHub keeps it on each socket, and nothing here
 * is written to D1. Every function is pure, so the hub and the tests share them.
 */

import type { UpdateReport } from "./releases";

/** Seeds per site: workstations that fetch a release from the internet before the rest copy it. */
export const LAN_SEEDS_PER_SITE = 2;
/** A seed told of a release this recently counts as one before it reports downloading. */
export const LAN_SEED_START_MS = 5 * 60_000;
/** The longest a workstation waits for a seed before it fetches the release from the internet. */
export const LAN_HOLD_MAX_MS = 60 * 60_000;
/** How long a workstation serves a release it holds (labkiosk-share.service's RuntimeMaxSec). */
export const LAN_SHARE_SECONDS = 48 * 60 * 60;
/** Peers named in one offer. */
export const MAX_LAN_PEERS = 8;
const MIN_PREFIX = 16;
const MAX_PREFIX = 30;

/** Where a workstation is on its LAN: its private IPv4 address and the subnet's prefix length. */
export interface LanReport {
  address: string;
  prefix: number;
}

/** What the hub knows about one workstation, as far as sharing goes. */
export interface SiteMember {
  clientId: string;
  /** The public address it connects from (CF-Connecting-IP). */
  ip: string;
  lan?: LanReport;
  update?: UpdateReport;
  /** When it was last told of a release, and which (OrgHub's reminder key). */
  nudgedAt?: number;
  nudgedVersion?: string;
}

function ipv4Number(address: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((o, i) => o > 255 || String(o) !== match[i + 1])) return null;
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function ipv4Text(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function mask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** 10/8, 172.16/12 and 192.168/16: the only networks a workstation shares on. */
function isPrivateIpv4(value: number): boolean {
  return value >>> 24 === 10 || value >>> 20 === 0xac1 || value >>> 16 === 0xc0a8;
}

/** A workstation's `lan` report, validated: a private IPv4 host address and a /16 to /30 prefix. */
export function normalizeLanReport(raw: unknown): LanReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const address = typeof r.address === "string" ? r.address : "";
  const value = ipv4Number(address);
  const prefix = r.prefix;
  if (value === null || !isPrivateIpv4(value)) return null;
  if (typeof prefix !== "number" || !Number.isInteger(prefix) || prefix < MIN_PREFIX || prefix > MAX_PREFIX) return null;
  const host = value & ~mask(prefix);
  // Neither the network's own address nor its broadcast address is a host.
  if (host === 0 || host === (~mask(prefix) >>> 0)) return null;
  return { address, prefix };
}

export function sameLanReport(a: LanReport | undefined, b: LanReport | undefined): boolean {
  if (!a || !b) return a === b;
  return a.address === b.address && a.prefix === b.prefix;
}

/** The public side of a site: an IPv4 address itself, or an IPv6 address's /64. */
function egressKey(ip: string): string | null {
  if (ipv4Number(ip) !== null) return ip;
  if (!/^[0-9a-fA-F:]{2,39}$/.test(ip) || !ip.includes(":")) return null;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** The site a workstation is at, or null when it cannot share (no LAN report, an unusable address). */
export function siteKey(ip: string, lan: LanReport | undefined): string | null {
  if (!lan) return null;
  const egress = egressKey(ip);
  const value = ipv4Number(lan.address);
  if (!egress || value === null) return null;
  return `${egress}|${ipv4Text((value & mask(lan.prefix)) >>> 0)}/${lan.prefix}`;
}

/** It holds `version` verified, in this boot, recently enough to still be serving it. */
function holds(member: SiteMember, version: string, nowMs: number): boolean {
  const update = member.update;
  if (!update || (update.phase !== "ready" && update.phase !== "staged") || update.version !== version) return false;
  return update.since === undefined || nowMs / 1000 - update.since < LAN_SHARE_SECONDS;
}

/** It is fetching `version` from the internet, or was just told to. */
function seeding(member: SiteMember, version: string, nowMs: number): boolean {
  const update = member.update;
  if (update?.phase === "downloading") return update.version === version;
  if (update?.phase === "error" || holds(member, version, nowMs)) return false;
  return member.nudgedVersion === version && member.nudgedAt !== undefined && nowMs - member.nudgedAt < LAN_SEED_START_MS;
}

/**
 * Whether a workstation should be told of `version` now (`go`) or wait for a
 * site member to finish fetching it (`hold`). It goes when someone at its site
 * holds the release (it copies it from them), when its site has fewer seeds than
 * LAN_SEEDS_PER_SITE (it becomes one), or once it has waited LAN_HOLD_MAX_MS.
 * `others` are the organization's other online workstations; only those at the
 * same site count.
 */
export function lanDecision(
  member: SiteMember,
  version: string,
  others: readonly SiteMember[],
  heldSince: number | undefined,
  nowMs: number
): "go" | "hold" {
  const site = siteKey(member.ip, member.lan);
  if (!site) return "go";
  const neighbours = others.filter((o) => o.clientId !== member.clientId && siteKey(o.ip, o.lan) === site);
  if (neighbours.some((o) => holds(o, version, nowMs))) return "go";
  if (neighbours.filter((o) => seeding(o, version, nowMs)).length < LAN_SEEDS_PER_SITE) return "go";
  if (heldSince !== undefined && nowMs - heldSince >= LAN_HOLD_MAX_MS) return "go";
  return "hold";
}

/** The LAN addresses of the site members a workstation may copy `version` from, in random order. */
export function lanPeers(member: SiteMember, version: string, others: readonly SiteMember[], nowMs: number): string[] {
  const site = siteKey(member.ip, member.lan);
  if (!site) return [];
  const peers = others
    .filter((o) => o.clientId !== member.clientId && siteKey(o.ip, o.lan) === site && holds(o, version, nowMs))
    .map((o) => o.lan!.address);
  // Spread the copies over every holder, so they double each round instead of all queueing at the seed.
  const order = new Uint32Array(peers.length);
  crypto.getRandomValues(order);
  return peers
    .map((address, i) => ({ address, key: order[i] }))
    .sort((a, b) => a.key - b.key)
    .slice(0, MAX_LAN_PEERS)
    .map((p) => p.address);
}
