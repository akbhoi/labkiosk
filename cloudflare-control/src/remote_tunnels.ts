/**
 * Automatic Remote Control tunnels, in one of two places an organization picks:
 *
 *   own       its own Cloudflare account and a domain on it: the administrator
 *             gives the platform an API token for that account, and a
 *             workstation is `<workstation>.<domain>`;
 *   platform  the platform's remote-control domain in the platform's account,
 *             for organizations with no domain: a workstation is
 *             `<organization>-<workstation>-vnc.<domain>`. The domain is the
 *             console's own (labkiosk.org) or a zone of its own; never a name
 *             under the console's domain, which the zone's certificate does
 *             not cover. On the console's domain each address gets a Worker
 *             route with no script so the tunnel, not the Worker, answers it.
 *             Organizations cannot be named `vnc` or `*-vnc` (src/guard.ts),
 *             and the console's CSRF guards treat pages there as cross-site,
 *             since the browser sends them its session cookie. Operators never open those
 *             addresses: they come through the Remote Control gate
 *             (src/remote_gate.ts), which signs in to each tunnel's Access
 *             application with the platform's service token, so no operator
 *             takes a Zero Trust seat in the platform's account.
 *
 * For each workstation that asks (GET /api/devices/tunnel), the Worker then
 * creates, in that account:
 *
 *   - a remotely managed Cloudflare Tunnel whose only public hostname is
 *     `<workstation>.<domain>`, forwarding to the workstation's loopback noVNC
 *     (127.0.0.1:6080);
 *   - the proxied CNAME for that hostname, and on the console's own domain a
 *     Worker route with no script for it;
 *   - a Cloudflare Access application in front of it, using one reusable
 *     Access policy per organization that allows only the people the
 *     administrator listed (the 8-character VNC password alone is not a
 *     defence for a public endpoint);
 *
 * and hands the workstation the tunnel's run token. The certificate is the
 * zone's own at Cloudflare's edge, so a workstation one label under the zone
 * (`pc-01.example.com`) is covered by the free Universal SSL certificate.
 *
 * An organization's API token and every run token are sealed with AES-GCM under
 * the REMOTE_TUNNEL_KEY secret before they reach D1, bound to the organization
 * (and workstation) they belong to. Without that secret the feature is
 * unavailable; without the REMOTE_TUNNEL_PLATFORM_* settings only `own` is.
 */

import { cleanCustomDomain } from "./escape";
import { isHostUnder, REMOTE_CONTROL_LABEL_SUFFIX, REMOTE_GATE_LABEL } from "./guard";
import { Env, Tenant } from "./types";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** What every tunnel forwards to: websockify on the workstation's loopback. */
export const TUNNEL_ORIGIN_SERVICE = "http://127.0.0.1:6080";
/** The comment on DNS records this module created, so it never takes over one it did not. */
export const DNS_RECORD_COMMENT = "Lab Kiosk Remote Control";
/** A failed workstation is tried again after this long, not on every request. */
export const PROVISION_RETRY_SECONDS = 600;
/** A claim older than this was abandoned (the request died) and may be taken over. */
export const PROVISIONING_STALE_SECONDS = 300;
/** People or domains an Access policy may list. */
export const MAX_ACCESS_RULES = 50;
/** Workstations whose tunnels one request removes; each costs four API calls. */
export const DEPROVISION_BATCH = 10;
const MAX_ERROR_LENGTH = 300;

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const API_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,256}$/;
const EMAIL_PATTERN = /^[a-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type RemoteTunnelMode = "own" | "platform";

export interface RemoteTunnelAccount {
  tenant_id: string;
  mode: RemoteTunnelMode;
  account_id: string;
  zone_id: string;
  domain: string;
  /** Sealed; NULL in `platform` mode, which uses the platform's own token. */
  api_token: string | null;
  access_rules: string;
  access_policy_id: string;
  created_at: number;
  updated_at: number;
}

export interface RemoteTunnelRow {
  tenant_id: string;
  client_id: string;
  hostname: string;
  tunnel_id: string | null;
  dns_record_id: string | null;
  route_id: string | null;
  access_app_id: string | null;
  token: string | null;
  status: "provisioning" | "active" | "failed";
  error: string | null;
  updated_at: number;
}

/** What a workstation is told: its tunnel, "not yet", or that it has none. */
export type WorkstationTunnel =
  | { state: "ready"; hostname: string; token: string }
  | { state: "pending" }
  | { state: "none" };

// --- Sealing secrets --------------------------------------------------------

export function remoteTunnelsAvailable(env: Env): boolean {
  return typeof env.REMOTE_TUNNEL_KEY === "string" && env.REMOTE_TUNNEL_KEY.trim() !== "";
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The 32 bytes of REMOTE_TUNNEL_KEY; throws when it is missing or malformed. */
export function remoteTunnelKeyBytes(env: Env): Uint8Array {
  if (!remoteTunnelsAvailable(env)) {
    throw new Error("REMOTE_TUNNEL_KEY is not set; Remote Control tunnels are unavailable");
  }
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(env.REMOTE_TUNNEL_KEY!.trim());
  } catch (err) {
    throw new Error(`REMOTE_TUNNEL_KEY is not valid base64: ${(err as Error).message}`);
  }
  if (raw.length !== 32) {
    throw new Error("REMOTE_TUNNEL_KEY must be 32 random bytes, base64-encoded");
  }
  return raw;
}

async function sealingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", remoteTunnelKeyBytes(env), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt a secret for D1. `context` (the organization, and the workstation for
 * a run token) is authenticated with it, so a sealed value copied to another
 * row does not open there.
 */
export async function sealSecret(env: Env, plaintext: string, context: string): Promise<string> {
  const key = await sealingKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(sealed))}`;
}

export async function openSecret(env: Env, sealed: string, context: string): Promise<string> {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unrecognized sealed secret");
  const key = await sealingKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parts[1]), additionalData: new TextEncoder().encode(context) },
    key,
    base64ToBytes(parts[2])
  );
  return new TextDecoder().decode(plain);
}

const accountContext = (tenantId: string) => `remote-tunnel-account:${tenantId}`;

// --- The platform's remote-control domain -------------------------------------

export interface PlatformTunnelConfig {
  accountId: string;
  zoneId: string;
  domain: string;
  apiToken: string;
  accessClientId: string;
  accessClientSecret: string;
}

const SERVICE_TOKEN_PART_PATTERN = /^[A-Za-z0-9._-]{16,256}$/;

/**
 * The platform's remote-control zone, or null when this server does not offer
 * one. Refused outright under the console's own domain (see the top of this file).
 */
export function platformTunnelConfig(env: Env): PlatformTunnelConfig | null {
  if (!remoteTunnelsAvailable(env)) return null;
  const domain = cleanCustomDomain(env.REMOTE_TUNNEL_PLATFORM_DOMAIN);
  const accountId = cleanAccountId(env.REMOTE_TUNNEL_PLATFORM_ACCOUNT_ID);
  const zoneId = cleanAccountId(env.REMOTE_TUNNEL_PLATFORM_ZONE_ID);
  const apiToken = cleanApiToken(env.REMOTE_TUNNEL_PLATFORM_TOKEN);
  const accessClientId = (env.REMOTE_TUNNEL_PLATFORM_ACCESS_CLIENT_ID || "").trim();
  const accessClientSecret = (env.REMOTE_TUNNEL_PLATFORM_ACCESS_CLIENT_SECRET || "").trim();
  if (!domain || !accountId || !zoneId || !apiToken) return null;
  if (!SERVICE_TOKEN_PART_PATTERN.test(accessClientId) || !SERVICE_TOKEN_PART_PATTERN.test(accessClientSecret)) return null;
  // The console's own domain itself is fine: browsers only ever open the gate,
  // and Access admits nothing but the gate's service token at a workstation's
  // address. A name under it is not: the one-label certificate does not cover
  // `<workstation>.<name>.<domain>`.
  const sharesConsole =
    env.DEFAULT_DOMAIN &&
    domain !== env.DEFAULT_DOMAIN.toLowerCase() &&
    (isHostUnder(domain, env.DEFAULT_DOMAIN) || isHostUnder(env.DEFAULT_DOMAIN, domain));
  if (sharesConsole) {
    console.error(
      `[RemoteTunnel] REMOTE_TUNNEL_PLATFORM_DOMAIN ${domain} is under or above ${env.DEFAULT_DOMAIN}; use that domain itself or a zone of its own. Platform tunnels are off`
    );
    return null;
  }
  return { accountId, zoneId, domain, apiToken, accessClientId, accessClientSecret };
}

/** The host the Remote Control gate answers on: one label no workstation address can take. */
export function remoteGateHost(platform: Pick<PlatformTunnelConfig, "domain">): string {
  return `${REMOTE_GATE_LABEL}.${platform.domain}`;
}

/** The API token that acts for an organization's tunnels. */
async function accountApiToken(env: Env, account: RemoteTunnelAccount): Promise<string> {
  if (account.mode === "platform") {
    const platform = platformTunnelConfig(env);
    if (!platform) throw new Error("This server no longer offers its remote-control domain (REMOTE_TUNNEL_PLATFORM_*)");
    return platform.apiToken;
  }
  if (!account.api_token) throw new Error("No Cloudflare API token is stored for this organization");
  return openSecret(env, account.api_token, accountContext(account.tenant_id));
}
const tunnelContext = (tenantId: string, clientId: string) => `remote-tunnel:${tenantId}:${clientId}`;

// --- Validating what an administrator enters --------------------------------

export function cleanAccountId(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return ACCOUNT_ID_PATTERN.test(value) ? value : null;
}

export function cleanApiToken(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return API_TOKEN_PATTERN.test(value) ? value : null;
}

/**
 * Who may open a workstation: email addresses and whole email domains, one per
 * entry. Returns null when any entry is neither, or there are none or too many.
 */
export function parseAccessRules(raw: unknown): string[] | null {
  const items = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,;]+/);
  const rules: string[] = [];
  for (const item of items) {
    const value = String(item ?? "").trim().toLowerCase().replace(/^@/, "");
    if (!value) continue;
    if (value.includes("@")) {
      if (!EMAIL_PATTERN.test(value)) return null;
    } else if (cleanCustomDomain(value) !== value) {
      return null;
    }
    if (!rules.includes(value)) rules.push(value);
  }
  return rules.length > 0 && rules.length <= MAX_ACCESS_RULES ? rules : null;
}

function dnsLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/** The hostname a workstation gets on an organization's own domain: its id as one DNS label. */
export function workstationHostname(clientId: string, domain: string): string | null {
  const label = dnsLabel(clientId);
  if (!label) return null;
  const host = `${label}.${domain}`;
  return host.length <= 253 ? host : null;
}

/**
 * The hostname on the platform's shared domain: `<organization>-<workstation>-vnc`,
 * still one label so the zone's certificate covers it. Null when that is longer
 * than a DNS label allows, rather than cutting it into someone else's name.
 */
export function platformWorkstationHostname(subdomain: string, clientId: string, domain: string): string | null {
  const org = dnsLabel(subdomain);
  const pc = dnsLabel(clientId);
  const label = `${org}-${pc}${REMOTE_CONTROL_LABEL_SUFFIX}`;
  if (!org || !pc || label.length > 63) return null;
  return `${label}.${domain}`;
}

/** True when tunnels share the zone the console's Worker is routed on. */
function sharesWorkerZone(env: Env, account: RemoteTunnelAccount): boolean {
  return account.mode === "platform" && !!env.DEFAULT_DOMAIN && account.domain === env.DEFAULT_DOMAIN.toLowerCase();
}

function tunnelHostname(account: RemoteTunnelAccount, tenant: Pick<Tenant, "subdomain">, clientId: string): string | null {
  return account.mode === "platform"
    ? platformWorkstationHostname(tenant.subdomain, clientId, account.domain)
    : workstationHostname(clientId, account.domain);
}

// --- The Cloudflare API, as the organization ---------------------------------

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

export class CloudflareApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function cfApi<T>(apiToken: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CLOUDFLARE_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data: CloudflareEnvelope<T>;
  try {
    data = (await res.json()) as CloudflareEnvelope<T>;
  } catch {
    throw new CloudflareApiError(`${method} ${path.split("?")[0]} answered HTTP ${res.status} without JSON`, res.status);
  }
  if (!res.ok || !data.success) {
    const detail = (data.errors || []).map((e) => `${e.code} ${e.message}`).join("; ") || "no detail";
    throw new CloudflareApiError(`${method} ${path.split("?")[0]} failed (HTTP ${res.status}): ${detail}`, res.status);
  }
  return data.result;
}

/** A DELETE that already happened (404) is not a failure. */
async function cfDelete(apiToken: string, path: string): Promise<void> {
  try {
    await cfApi<unknown>(apiToken, "DELETE", path);
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return;
    throw err;
  }
}

/** The zone `domain` belongs to in the account: the domain itself or a parent of it. */
async function findZone(apiToken: string, accountId: string, domain: string): Promise<{ id: string; name: string }> {
  const labels = domain.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join(".");
    const zones = await cfApi<Array<{ id: string; name: string }>>(
      apiToken,
      "GET",
      `/zones?name=${encodeURIComponent(candidate)}&account.id=${encodeURIComponent(accountId)}`
    );
    if (zones.length > 0) return { id: zones[0].id, name: zones[0].name };
  }
  throw new CloudflareApiError(`${domain} is not a zone in this Cloudflare account, or the token cannot read it`, 404);
}

/**
 * Check, before anything is stored, that the token reaches everything a tunnel
 * needs: the zone (DNS), tunnels and Access in the account. Returns the zone.
 */
export async function checkAccountAccess(
  apiToken: string,
  accountId: string,
  domain: string
): Promise<{ zoneId: string; zoneName: string }> {
  const zone = await findZone(apiToken, accountId, domain);
  await cfApi<unknown>(apiToken, "GET", `/zones/${encodeURIComponent(zone.id)}/dns_records?per_page=5`);
  await cfApi<unknown>(apiToken, "GET", `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?per_page=5&is_deleted=false`);
  await cfApi<unknown>(apiToken, "GET", `/accounts/${encodeURIComponent(accountId)}/access/apps?per_page=5`);
  return { zoneId: zone.id, zoneName: zone.name };
}

function accessInclude(rules: string[]): Array<Record<string, unknown>> {
  return rules.map((rule) =>
    rule.includes("@") ? { email: { email: rule } } : { email_domain: { domain: rule } }
  );
}

// --- Storage ----------------------------------------------------------------

export async function getRemoteTunnelAccount(db: D1Database, tenantId: string): Promise<RemoteTunnelAccount | null> {
  return db
    .prepare("SELECT * FROM remote_tunnel_accounts WHERE tenant_id = ?")
    .bind(tenantId)
    .first<RemoteTunnelAccount>();
}

/** Why an organization's settings were refused, with the HTTP status to answer. */
export class RemoteTunnelSetupError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type RemoteTunnelSettings =
  | {
      mode: "own";
      accountId: string;
      domain: string;
      /** null keeps the stored token (only while the account stays the same). */
      apiToken: string | null;
      accessRules: string[];
    }
  | { mode: "platform" };

function accessPolicyBody(tenant: Pick<Tenant, "subdomain">, rules: string[]): Record<string, unknown> {
  return {
    name: `Lab Kiosk Remote Control (${tenant.subdomain})`,
    decision: "allow",
    include: accessInclude(rules)
  };
}

/**
 * On the platform's domain only the gate's service token gets through: the
 * operator was already checked by the console, and a service token takes no seat.
 */
function serviceTokenPolicyBody(tenant: Pick<Tenant, "subdomain">, serviceTokenId: string): Record<string, unknown> {
  return {
    name: `Lab Kiosk Remote Control gate (${tenant.subdomain})`,
    decision: "non_identity",
    include: [{ service_token: { token_id: serviceTokenId } }]
  };
}

/** The id of the platform's service token, found by its client id. */
async function platformServiceTokenId(platform: PlatformTunnelConfig): Promise<string> {
  const tokens = await cfApi<Array<{ id: string; client_id: string }>>(
    platform.apiToken,
    "GET",
    `/accounts/${encodeURIComponent(platform.accountId)}/access/service_tokens?per_page=1000`
  );
  const token = tokens.find((t) => t.client_id === platform.accessClientId);
  if (!token) {
    throw new RemoteTunnelSetupError(
      "The platform's Access service token (REMOTE_TUNNEL_PLATFORM_ACCESS_CLIENT_ID) is not in its Cloudflare account",
      409
    );
  }
  return token.id;
}

/**
 * Turn automatic tunnels on, or change them. An organization's own token is
 * checked against its account before anything is stored, and the
 * organization's Access policy is created or updated so existing workstations
 * follow a change of who may connect at once. Where the tunnels live cannot
 * change while workstations still have tunnels in the old place.
 */
export async function configureRemoteTunnels(
  env: Env,
  db: D1Database,
  tenant: Pick<Tenant, "id" | "subdomain">,
  settings: RemoteTunnelSettings,
  now: number
): Promise<{ domain: string; zoneName: string }> {
  if (!remoteTunnelsAvailable(env)) {
    throw new RemoteTunnelSetupError("Automatic Remote Control tunnels are not available on this server", 409);
  }
  const existing = await getRemoteTunnelAccount(db, tenant.id);

  let accountId: string;
  let domain: string;
  let apiToken: string;
  let zone: { zoneId: string; zoneName: string };
  let policyBody: Record<string, unknown>;
  let accessRules: string[];
  if (settings.mode === "platform") {
    const platform = platformTunnelConfig(env);
    if (!platform) {
      throw new RemoteTunnelSetupError("This server does not offer workstation addresses of its own; use your own Cloudflare domain", 409);
    }
    ({ accountId, domain, apiToken } = platform);
    zone = { zoneId: platform.zoneId, zoneName: platform.domain };
    try {
      policyBody = serviceTokenPolicyBody(tenant, await platformServiceTokenId(platform));
    } catch (err) {
      if (err instanceof CloudflareApiError) {
        throw new RemoteTunnelSetupError(`Cloudflare refused the platform's token: ${err.message}`, 502);
      }
      throw err;
    }
    accessRules = [];
  } else {
    policyBody = accessPolicyBody(tenant, settings.accessRules);
    accessRules = settings.accessRules;
    accountId = settings.accountId;
    domain = settings.domain;
    const keepToken = existing?.mode === "own" && existing.account_id === accountId;
    const token = settings.apiToken ?? (keepToken ? await accountApiToken(env, existing!) : null);
    if (!token) throw new RemoteTunnelSetupError("A Cloudflare API token is required", 400);
    apiToken = token;
    try {
      zone = await checkAccountAccess(apiToken, accountId, domain);
    } catch (err) {
      if (err instanceof CloudflareApiError) {
        throw new RemoteTunnelSetupError(`Cloudflare refused the token: ${err.message}`, 400);
      }
      throw err;
    }
  }

  const samePlace = existing !== null && existing.mode === settings.mode && existing.account_id === accountId;
  if (existing && (!samePlace || existing.domain !== domain)) {
    const { total } = await countRemoteTunnels(db, tenant.id);
    if (total > 0) {
      throw new RemoteTunnelSetupError(
        `Turn automatic tunnels off first: ${total} workstation(s) still have tunnels on ${existing.domain}`,
        409
      );
    }
  }

  const accountPath = `/accounts/${encodeURIComponent(accountId)}`;
  const body = policyBody;
  let policyId: string;
  try {
    policyId = samePlace
      ? (await cfApi<{ id: string }>(apiToken, "PUT", `${accountPath}/access/policies/${encodeURIComponent(existing!.access_policy_id)}`, body)).id
      : (await cfApi<{ id: string }>(apiToken, "POST", `${accountPath}/access/policies`, body)).id;
  } catch (err) {
    if (err instanceof CloudflareApiError) {
      throw new RemoteTunnelSetupError(`Cloudflare Access refused the policy (is Zero Trust set up on this account?): ${err.message}`, 400);
    }
    throw err;
  }

  if (existing && !samePlace) {
    // The old policy is no longer used by anything. Its token may already be
    // revoked, which must not stop the move, so the failure is logged for the
    // administrator's own clean-up rather than thrown.
    try {
      const oldToken = await accountApiToken(env, existing);
      await cfDelete(oldToken, `/accounts/${encodeURIComponent(existing.account_id)}/access/policies/${encodeURIComponent(existing.access_policy_id)}`);
    } catch (err) {
      console.error(`[RemoteTunnel] ${tenant.subdomain}: could not delete the old Access policy ${existing.access_policy_id}: ${(err as Error).message}`);
    }
  }

  const sealed = settings.mode === "own" ? await sealSecret(env, apiToken, accountContext(tenant.id)) : null;
  await db
    .prepare(
      `INSERT INTO remote_tunnel_accounts (tenant_id, mode, account_id, zone_id, domain, api_token, access_rules, access_policy_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET mode = excluded.mode, account_id = excluded.account_id, zone_id = excluded.zone_id,
         domain = excluded.domain, api_token = excluded.api_token, access_rules = excluded.access_rules,
         access_policy_id = excluded.access_policy_id, updated_at = excluded.updated_at`
    )
    .bind(tenant.id, settings.mode, accountId, zone.zoneId, domain, sealed, JSON.stringify(accessRules), policyId, now, now)
    .run();
  return { domain, zoneName: zone.zoneName };
}

export async function countRemoteTunnels(db: D1Database, tenantId: string): Promise<{ total: number; active: number; failed: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM remote_tunnels WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<{ total: number; active: number | null; failed: number | null }>();
  return { total: Number(row?.total || 0), active: Number(row?.active || 0), failed: Number(row?.failed || 0) };
}

async function getTunnelRow(db: D1Database, tenantId: string, clientId: string): Promise<RemoteTunnelRow | null> {
  return db
    .prepare("SELECT * FROM remote_tunnels WHERE tenant_id = ? AND client_id = ?")
    .bind(tenantId, clientId)
    .first<RemoteTunnelRow>();
}

async function recordIds(
  db: D1Database,
  tenantId: string,
  clientId: string,
  ids: Partial<Pick<RemoteTunnelRow, "tunnel_id" | "dns_record_id" | "route_id" | "access_app_id">>,
  now: number
): Promise<void> {
  const columns = Object.keys(ids) as Array<keyof typeof ids>;
  if (columns.length === 0) return;
  await db
    .prepare(
      `UPDATE remote_tunnels SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ?
        WHERE tenant_id = ? AND client_id = ?`
    )
    .bind(...columns.map((c) => ids[c] ?? null), now, tenantId, clientId)
    .run();
}

async function recordProblem(db: D1Database, tenantId: string, clientId: string, message: string, now: number): Promise<void> {
  const error = message.slice(0, MAX_ERROR_LENGTH);
  await db
    .prepare("UPDATE remote_tunnels SET status = 'failed', error = ?, updated_at = ? WHERE tenant_id = ? AND client_id = ?")
    .bind(error, now, tenantId, clientId)
    .run();
  // Settings -> Errors & Warnings. A tunnel the organization's own account
  // refused is not a fault in Lab Kiosk, so it is never sent as a bug report.
  await db
    .prepare(
      `INSERT INTO workstation_issues (id, tenant_id, client_id, severity, kind, image_version, details, occurred_at, created_at, report_state)
       VALUES (?, ?, ?, 'warning', 'remote_tunnel_failed', NULL, ?, ?, ?, 'none')`
    )
    .bind(crypto.randomUUID(), tenantId, clientId, error, now, now)
    .run();
}

// --- One workstation's tunnel -----------------------------------------------

/**
 * The tunnel a workstation should run, creating it on first request. Only one
 * request creates it: the row is claimed atomically first, and a concurrent
 * request is told "pending".
 */
export async function workstationTunnel(
  env: Env,
  db: D1Database,
  tenant: Pick<Tenant, "id" | "subdomain">,
  clientId: string,
  now: number
): Promise<WorkstationTunnel> {
  if (!remoteTunnelsAvailable(env)) return { state: "none" };
  const account = await getRemoteTunnelAccount(db, tenant.id);
  if (!account) return { state: "none" };

  const existing = await getTunnelRow(db, tenant.id, clientId);
  if (existing?.status === "active" && existing.token) {
    return {
      state: "ready",
      hostname: existing.hostname,
      token: await openSecret(env, existing.token, tunnelContext(tenant.id, clientId))
    };
  }

  const hostname = tunnelHostname(account, tenant, clientId);
  if (!hostname) {
    console.error(`[RemoteTunnel] ${tenant.subdomain}/${clientId}: no valid address under ${account.domain}`);
    return { state: "none" };
  }

  const claim = await db
    .prepare(
      `INSERT INTO remote_tunnels (tenant_id, client_id, hostname, status, updated_at)
       VALUES (?, ?, ?, 'provisioning', ?)
       ON CONFLICT(tenant_id, client_id) DO UPDATE SET status = 'provisioning', error = NULL, hostname = excluded.hostname, updated_at = excluded.updated_at
        WHERE (remote_tunnels.status = 'failed' AND remote_tunnels.updated_at <= ?)
           OR (remote_tunnels.status = 'provisioning' AND remote_tunnels.updated_at <= ?)`
    )
    .bind(tenant.id, clientId, hostname, now, now - PROVISION_RETRY_SECONDS, now - PROVISIONING_STALE_SECONDS)
    .run();
  if (!claim.meta.changes) return { state: "pending" };

  const row = (await getTunnelRow(db, tenant.id, clientId))!;
  try {
    const apiToken = await accountApiToken(env, account);
    const token = await provision(apiToken, account, tenant, clientId, hostname, row, db, now, sharesWorkerZone(env, account));
    const sealed = await sealSecret(env, token, tunnelContext(tenant.id, clientId));
    await db
      .prepare("UPDATE remote_tunnels SET token = ?, status = 'active', error = NULL, updated_at = ? WHERE tenant_id = ? AND client_id = ?")
      .bind(sealed, now, tenant.id, clientId)
      .run();
    return { state: "ready", hostname, token };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[RemoteTunnel] ${tenant.subdomain}/${clientId}: ${message}`);
    await recordProblem(db, tenant.id, clientId, message, now);
    return { state: "pending" };
  }
}

async function provision(
  apiToken: string,
  account: RemoteTunnelAccount,
  tenant: Pick<Tenant, "id" | "subdomain">,
  clientId: string,
  hostname: string,
  row: RemoteTunnelRow,
  db: D1Database,
  now: number,
  bypassWorker: boolean
): Promise<string> {
  const accountPath = `/accounts/${encodeURIComponent(account.account_id)}`;
  const zonePath = `/zones/${encodeURIComponent(account.zone_id)}`;

  // 0. An address another workstation holds -- on the platform domain, possibly
  //    another organization's ("a-b" + "c" and "a" + "b-c") -- is never shared.
  const holder = await db
    .prepare("SELECT tenant_id FROM remote_tunnels WHERE hostname = ? AND NOT (tenant_id = ? AND client_id = ?) LIMIT 1")
    .bind(hostname, tenant.id, clientId)
    .first<{ tenant_id: string }>();
  if (holder) {
    throw new Error(`${hostname} is already another workstation's address; rename this workstation`);
  }

  // 1. The tunnel, named after the workstation so a lost id is found again.
  let tunnelId = row.tunnel_id;
  if (!tunnelId) {
    const name = `labkiosk-${tenant.subdomain}-${hostname.split(".")[0]}`;
    const found = await cfApi<Array<{ id: string }>>(
      apiToken,
      "GET",
      `${accountPath}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`
    );
    tunnelId = found.length > 0
      ? found[0].id
      : (await cfApi<{ id: string }>(apiToken, "POST", `${accountPath}/cfd_tunnel`, { name, config_src: "cloudflare" })).id;
    await recordIds(db, tenant.id, clientId, { tunnel_id: tunnelId }, now);
  }

  // 2. Its one public hostname, to noVNC on the workstation's loopback.
  await cfApi<unknown>(apiToken, "PUT", `${accountPath}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, {
    config: {
      ingress: [
        { hostname, service: TUNNEL_ORIGIN_SERVICE },
        { service: "http_status:404" }
      ]
    }
  });

  // 3. The DNS record. Only one pointing at this very tunnel (left by an
  //    attempt that died before saving its id) is reused; any other record,
  //    including another workstation's, is never taken over.
  const target = `${tunnelId}.cfargotunnel.com`;
  if (!row.dns_record_id) {
    const records = await cfApi<Array<{ id: string; type: string; content: string; comment?: string | null }>>(
      apiToken,
      "GET",
      `${zonePath}/dns_records?name=${encodeURIComponent(hostname)}`
    );
    const ours = records.find((r) => r.type === "CNAME" && r.comment === DNS_RECORD_COMMENT && r.content === target);
    const foreign = records.find((r) => r !== ours);
    if (foreign) {
      throw new Error(`${hostname} already has a ${foreign.type} record that Lab Kiosk did not create; remove it or rename the workstation`);
    }
    const record = { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1, comment: DNS_RECORD_COMMENT };
    const saved = ours
      ? await cfApi<{ id: string }>(apiToken, "PUT", `${zonePath}/dns_records/${encodeURIComponent(ours.id)}`, record)
      : await cfApi<{ id: string }>(apiToken, "POST", `${zonePath}/dns_records`, record);
    await recordIds(db, tenant.id, clientId, { dns_record_id: saved.id }, now);
  }

  // 3b. On the console's own domain the Worker's `*.<domain>/*` route would
  //     answer for this address before the tunnel could; a route with no
  //     Worker, more specific than the wildcard, hands it back to the tunnel.
  if (bypassWorker && !row.route_id) {
    const pattern = `${hostname}/*`;
    const routes = await cfApi<Array<{ id: string; pattern: string; script?: string | null }>>(apiToken, "GET", `${zonePath}/workers/routes`);
    const existing = routes.find((r) => r.pattern === pattern);
    if (existing?.script) {
      throw new Error(`${pattern} is already routed to the Worker ${existing.script}; remove that route or rename the workstation`);
    }
    const routeId = existing
      ? existing.id
      : (await cfApi<{ id: string }>(apiToken, "POST", `${zonePath}/workers/routes`, { pattern })).id;
    await recordIds(db, tenant.id, clientId, { route_id: routeId }, now);
  }

  // 4. Access in front of it, with the organization's policy. The console
  //    shows noVNC in a frame, so the application allows framing and its
  //    cookie is SameSite=None. On the platform's domain the policy admits only
  //    the gate's service token (src/remote_gate.ts).
  if (!row.access_app_id) {
    const app = await cfApi<{ id: string }>(apiToken, "POST", `${accountPath}/access/apps`, {
      name: `Lab Kiosk ${tenant.subdomain} ${clientId}`,
      domain: hostname,
      type: "self_hosted",
      session_duration: "8h",
      app_launcher_visible: false,
      allow_iframe: true,
      same_site_cookie_attribute: "none",
      http_only_cookie_attribute: true,
      policies: [{ id: account.access_policy_id, precedence: 1 }]
    });
    await recordIds(db, tenant.id, clientId, { access_app_id: app.id }, now);
  }

  // 5. The token the workstation runs the tunnel with.
  const token = await cfApi<string>(apiToken, "GET", `${accountPath}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`);
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("Cloudflare returned no usable tunnel token");
  }
  return token;
}

/**
 * Delete what was created for one workstation, then its row. Throws when the
 * organization's account refuses, leaving the row so it can be tried again.
 */
export async function deprovisionWorkstationTunnel(
  env: Env,
  db: D1Database,
  tenantId: string,
  clientId: string
): Promise<boolean> {
  const row = await getTunnelRow(db, tenantId, clientId);
  if (!row) return false;
  const account = await getRemoteTunnelAccount(db, tenantId);
  if (!account) throw new Error("This organization's Cloudflare account is no longer configured");
  const apiToken = await accountApiToken(env, account);
  const accountPath = `/accounts/${encodeURIComponent(account.account_id)}`;

  if (row.access_app_id) {
    await cfDelete(apiToken, `${accountPath}/access/apps/${encodeURIComponent(row.access_app_id)}`);
  }
  if (row.route_id) {
    await cfDelete(apiToken, `/zones/${encodeURIComponent(account.zone_id)}/workers/routes/${encodeURIComponent(row.route_id)}`);
  }
  if (row.dns_record_id) {
    await cfDelete(apiToken, `/zones/${encodeURIComponent(account.zone_id)}/dns_records/${encodeURIComponent(row.dns_record_id)}`);
  }
  if (row.tunnel_id) {
    // A tunnel with live connections cannot be deleted; drop them first.
    await cfDelete(apiToken, `${accountPath}/cfd_tunnel/${encodeURIComponent(row.tunnel_id)}/connections`);
    await cfDelete(apiToken, `${accountPath}/cfd_tunnel/${encodeURIComponent(row.tunnel_id)}`);
  }
  await db.prepare("DELETE FROM remote_tunnels WHERE tenant_id = ? AND client_id = ?").bind(tenantId, clientId).run();
  return true;
}

/**
 * Remove up to DEPROVISION_BATCH workstations' tunnels; once none are left,
 * forget the account. Returns how many remain, so the console can call again.
 */
export async function turnOffRemoteTunnels(env: Env, db: D1Database, tenantId: string): Promise<{ remaining: number }> {
  const rows = await db
    .prepare("SELECT client_id FROM remote_tunnels WHERE tenant_id = ? ORDER BY client_id LIMIT ?")
    .bind(tenantId, DEPROVISION_BATCH)
    .all<{ client_id: string }>();
  for (const { client_id } of rows.results || []) {
    await deprovisionWorkstationTunnel(env, db, tenantId, client_id);
  }
  const { total } = await countRemoteTunnels(db, tenantId);
  if (total === 0) {
    const account = await getRemoteTunnelAccount(db, tenantId);
    if (account) {
      const apiToken = await accountApiToken(env, account);
      await cfDelete(apiToken, `/accounts/${encodeURIComponent(account.account_id)}/access/policies/${encodeURIComponent(account.access_policy_id)}`);
      await db.prepare("DELETE FROM remote_tunnel_accounts WHERE tenant_id = ?").bind(tenantId).run();
    }
  }
  return { remaining: total };
}
