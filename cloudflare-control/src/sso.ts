/**
 * Single sign-on for organization staff with Google Workspace or Microsoft
 * Entra ID: OpenID Connect, authorization code flow with PKCE (S256), `state`
 * and `nonce`. Never for the super admin, never for workstations.
 *
 * - The platform has one OAuth client per provider (GOOGLE_CLIENT_ID/SECRET,
 *   MICROSOFT_CLIENT_ID/SECRET) and one redirect URI for every organization:
 *   https://<platform host>/api/auth/sso/callback, the platform host being
 *   CANONICAL_HOST when set and DEFAULT_DOMAIN otherwise. A provider without both of
 *   its secrets is not offered, and the server logs why once per isolate.
 * - An organization turns a provider on under Settings -> Security and names
 *   who may use it: Google Workspace domains (the ID token's `hd`) and Entra
 *   tenant ids (its `tid`). Only administrators change this, since whoever runs
 *   a listed directory decides which email addresses its accounts carry.
 * - The verified email must belong to an existing staff account (or the
 *   owner) of that organization. Nothing is created. After the match the
 *   organization's second-factor rule applies exactly as after a password:
 *   the sign-in continues through `continueSignIn` (src/two_factor.ts).
 *
 * The flow, across hosts:
 *   1. GET /api/auth/sso/start?provider=… on the sign-in page's host (the
 *      platform apex with ?tenant=, the organization's subdomain, or its
 *      custom domain) stores a `sso_states` row, sets a cookie binding it to
 *      this browser and sends the browser to the provider.
 *   2. The provider returns to GET /api/auth/sso/callback on the platform host.
 *      The state is spent, the code exchanged, the ID token verified here with
 *      crypto.subtle and the account matched. The row then carries a one-time
 *      code (two minutes) and the browser goes back to the sign-in page it
 *      started on with `?sso=<code>`.
 *   3. That page POSTs the code to /api/auth/sso/redeem on its own host. The
 *      code works once, on that host, in the browser that started the sign-in,
 *      and the answer is what a password sign-in answers: a session (through the
 *      usual handoff to the console's host) or the second-factor step.
 *
 * Nothing two requests must agree on lives in memory: states are rows in D1.
 * The providers' signing keys are cached per isolate, which is only a cache.
 */

import type { Env, Tenant, User } from "./types";
import { jsonError, hostname } from "./guard";
import { bufferToHex, parseCookies, sha256Hex, timingSafeEqual } from "./auth";
import { clearLoginFailures, findUserByEmail, getLockoutRemaining, rateLimitWait, recordLoginFailure, recordRateLimitHit, writeAuditLog } from "./db";
import { canonicalHost } from "./seo";
import { escapeHtml } from "./escape";
import { renderStatusPageHtml } from "./ui_status";
import type { RouteContext } from "./signup";
import { continueSignIn, type CookieOptions } from "./two_factor";

export type SsoProvider = "google" | "microsoft";
export const SSO_PROVIDERS: readonly SsoProvider[] = ["google", "microsoft"];

export const SSO_CALLBACK_PATH = "/api/auth/sso/callback";

/** How long the provider may take to send the browser back. */
const STATE_SECONDS = 10 * 60;
/** How long the sign-in page has to redeem the code the callback hands it. */
const HANDOFF_SECONDS = 2 * 60;
/** Sign-ins one address may start per window. */
const START_LIMIT = { perAddress: 30, windowSeconds: 10 * 60 };
/** Allowed clock difference with the provider, for `exp`, `iat` and `nbf`. */
const CLOCK_SKEW_SECONDS = 120;
/** Domains or tenant ids one organization may list per provider. */
const MAX_ALLOWED_ENTRIES = 20;
const MAX_ID_TOKEN_LENGTH = 16 * 1024;
const PROVIDER_TIMEOUT_MS = 10_000;
const BROWSER_COOKIE = "labkiosk_sso";
/** The Entra tenant of personal Microsoft accounts: never an organization's directory. */
const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const CONSUMER_GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

const now = () => Math.floor(Date.now() / 1000);

interface ProviderEndpoints {
  label: string;
  authorize: string;
  token: string;
  jwks: string;
}

const ENDPOINTS: Record<SsoProvider, ProviderEndpoints> = {
  google: {
    label: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    jwks: "https://www.googleapis.com/oauth2/v3/certs"
  },
  microsoft: {
    // The multi-tenant endpoint for work and school accounts only.
    label: "Microsoft",
    authorize: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    jwks: "https://login.microsoftonline.com/organizations/discovery/v2.0/keys"
  }
};

export function isSsoProvider(value: unknown): value is SsoProvider {
  return value === "google" || value === "microsoft";
}

export function ssoProviderLabel(provider: SsoProvider): string {
  return ENDPOINTS[provider].label;
}

// ---------------------------------------------------------- platform secrets

const loggedMissing = new Set<SsoProvider>();

function clientCredentials(env: Env, provider: SsoProvider): { id: string; secret: string } | null {
  const id = (provider === "google" ? env.GOOGLE_CLIENT_ID : env.MICROSOFT_CLIENT_ID)?.trim() || "";
  const secret = (provider === "google" ? env.GOOGLE_CLIENT_SECRET : env.MICROSOFT_CLIENT_SECRET)?.trim() || "";
  if (id && secret) return { id, secret };
  if (!loggedMissing.has(provider)) {
    loggedMissing.add(provider);
    const prefix = provider === "google" ? "GOOGLE" : "MICROSOFT";
    console.warn(`[SSO] ${ENDPOINTS[provider].label} sign-in is not offered: ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET are not both set.`);
  }
  return null;
}

/** True when the platform has this provider's OAuth client. */
export function ssoProviderAvailable(env: Env, provider: SsoProvider): boolean {
  return clientCredentials(env, provider) !== null;
}

/**
 * The callback the provider is given: the platform host in production (CANONICAL_HOST when the
 * zone redirects the apex there, DEFAULT_DOMAIN otherwise), this host on a dev host.
 */
export function ssoRedirectUri(env: Env, request: Request, isDev: boolean): string | null {
  if (isDev) return `${new URL(request.url).origin}${SSO_CALLBACK_PATH}`;
  const host = canonicalHost(env);
  return host ? `https://${host}${SSO_CALLBACK_PATH}` : null;
}

// ---------------------------------------------------- organization settings

export interface SsoSettings {
  googleEnabled: boolean;
  googleDomains: string[];
  microsoftEnabled: boolean;
  microsoftTenants: string[];
  requireSso: boolean;
}

interface SsoSettingsRow {
  google_enabled: number;
  google_domains: string;
  microsoft_enabled: number;
  microsoft_tenants: string;
  require_sso: number;
}

const NO_SETTINGS: SsoSettings = { googleEnabled: false, googleDomains: [], microsoftEnabled: false, microsoftTenants: [], requireSso: false };

function stringList(json: string): string[] {
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
  } catch (err) {
    // A damaged list allows nobody, which is the safe reading of it.
    console.error("[SSO] An organization's allowed list could not be read:", err);
    return [];
  }
}

export async function getSsoSettings(db: D1Database, tenantId: string): Promise<SsoSettings> {
  const row = await db
    .prepare("SELECT google_enabled, google_domains, microsoft_enabled, microsoft_tenants, require_sso FROM sso_settings WHERE tenant_id = ?")
    .bind(tenantId)
    .first<SsoSettingsRow>();
  if (!row) return { ...NO_SETTINGS };
  return {
    googleEnabled: row.google_enabled === 1,
    googleDomains: stringList(row.google_domains),
    microsoftEnabled: row.microsoft_enabled === 1,
    microsoftTenants: stringList(row.microsoft_tenants),
    requireSso: row.require_sso === 1
  };
}

function enabledIn(settings: SsoSettings, provider: SsoProvider): boolean {
  return provider === "google"
    ? settings.googleEnabled && settings.googleDomains.length > 0
    : settings.microsoftEnabled && settings.microsoftTenants.length > 0;
}

/** The providers this organization's sign-in page offers: turned on here, and configured by the platform. */
export function offeredProviders(env: Env, settings: SsoSettings): SsoProvider[] {
  return SSO_PROVIDERS.filter((p) => enabledIn(settings, p) && ssoProviderAvailable(env, p));
}

/** The sign-in buttons for an organization's sign-in page, or none. */
export async function ssoButtonsFor(db: D1Database, env: Env, tenant: Tenant | null): Promise<SsoProvider[]> {
  if (!tenant || tenant.status !== "active") return [];
  return offeredProviders(env, await getSsoSettings(db, tenant.id));
}

/**
 * Why a password sign-in must be refused, or null. With "require SSO" on and a
 * provider offered, staff sign in with it; the owner keeps the password, so the
 * organization can always get back in (to fix its directory, or turn this off).
 * A provider the platform stops offering lifts the requirement rather than
 * locking everyone out.
 */
export async function passwordSignInRefusal(db: D1Database, env: Env, user: Pick<User, "id" | "role">, tenant: Tenant | null): Promise<string | null> {
  if (!tenant || user.role === "super_admin" || tenant.user_id === user.id) return null;
  const settings = await getSsoSettings(db, tenant.id);
  if (!settings.requireSso) return null;
  const offered = offeredProviders(env, settings);
  if (!offered.length) return null;
  const names = offered.map((p) => ENDPOINTS[p].label).join(" or ");
  return `${tenant.name} signs its staff in with ${names}. Use "Continue with ${ENDPOINTS[offered[0]].label}" on your organization's sign-in page.`;
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cleanList(value: unknown, field: string, check: (item: string) => string | null): { list: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: `${field} is a list` };
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return { error: `${field} holds text only` };
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    const problem = check(item);
    if (problem) return { error: problem };
    if (!out.includes(item)) out.push(item);
  }
  if (out.length > MAX_ALLOWED_ENTRIES) return { error: `${field} holds at most ${MAX_ALLOWED_ENTRIES} entries` };
  return { list: out };
}

/** The settings a POST asks for, or what is wrong with it. */
export function parseSsoSettings(body: unknown): { settings: SsoSettings } | { error: string } {
  if (!body || typeof body !== "object") return { error: "The request body must be a JSON object" };
  const b = body as Record<string, any>;
  const google = b.google, microsoft = b.microsoft;
  if (!google || typeof google !== "object" || typeof google.enabled !== "boolean") return { error: "google.enabled is true or false" };
  if (!microsoft || typeof microsoft !== "object" || typeof microsoft.enabled !== "boolean") return { error: "microsoft.enabled is true or false" };
  if (typeof b.requireSso !== "boolean") return { error: "requireSso is true or false" };
  const domains = cleanList(google.domains ?? [], "google.domains", (d) => {
    if (!DOMAIN_PATTERN.test(d)) return `"${d.slice(0, 80)}" is not a domain name`;
    if (CONSUMER_GOOGLE_DOMAINS.has(d)) return `${d} is for personal Google accounts; name your Google Workspace domain`;
    return null;
  });
  if ("error" in domains) return domains;
  const tenants = cleanList(microsoft.tenants ?? [], "microsoft.tenants", (t) => {
    if (!TENANT_ID_PATTERN.test(t)) return `"${t.slice(0, 80)}" is not an Entra tenant id (a GUID such as 72f988bf-86f1-41af-91ab-2d7cd011db47)`;
    if (t === MICROSOFT_CONSUMER_TENANT) return "That tenant id is the one for personal Microsoft accounts; name your organization's directory";
    return null;
  });
  if ("error" in tenants) return tenants;
  if (google.enabled && !domains.list.length) return { error: "Name at least one Google Workspace domain to turn Google sign-in on" };
  if (microsoft.enabled && !tenants.list.length) return { error: "Name at least one Entra tenant id to turn Microsoft sign-in on" };
  if (b.requireSso && !google.enabled && !microsoft.enabled) return { error: "Turn a provider on before requiring single sign-on" };
  return {
    settings: {
      googleEnabled: google.enabled,
      googleDomains: domains.list,
      microsoftEnabled: microsoft.enabled,
      microsoftTenants: tenants.list,
      requireSso: b.requireSso
    }
  };
}

/** Owner, `org_admin` staff, or the super admin inside one of its demos (the caller checked the guard). */
async function administers(db: D1Database, tenant: Tenant, userId: string, role: string): Promise<boolean> {
  if (role === "super_admin" || tenant.user_id === userId) return true;
  const row = await db
    .prepare("SELECT 1 FROM tenant_users WHERE tenant_id = ? AND user_id = ? AND role = 'org_admin'")
    .bind(tenant.id, userId)
    .first();
  return Boolean(row);
}

function describeSettings(s: SsoSettings): string {
  return [
    `google=${s.googleEnabled ? "on" : "off"}`,
    `google_domains=${s.googleDomains.join(",") || "-"}`,
    `microsoft=${s.microsoftEnabled ? "on" : "off"}`,
    `microsoft_tenants=${s.microsoftTenants.join(",") || "-"}`,
    `require_sso=${s.requireSso ? "on" : "off"}`
  ].join(" ");
}

/**
 * GET/POST /api/settings/sso. The caller has already checked the `settings`
 * permission; changing the configuration also needs an administrator.
 */
export async function handleSsoSettings(ctx: RouteContext, tenant: Tenant): Promise<Response> {
  const { db, env, request, session, jsonHeaders, isDev } = ctx;
  const canEdit = await administers(db, tenant, session!.user_id, session!.role);
  let settings = await getSsoSettings(db, tenant.id);
  if (request.method === "POST") {
    if (!canEdit) return jsonError("Only the organization's administrators change single sign-on", 403, jsonHeaders);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("The request body must be JSON", 400, jsonHeaders);
    }
    const parsed = parseSsoSettings(body);
    if ("error" in parsed) return jsonError(parsed.error, 400, jsonHeaders);
    const next = parsed.settings;
    // Turning on a provider the platform does not offer would show staff nothing to press.
    for (const provider of SSO_PROVIDERS) {
      const turningOn = provider === "google" ? next.googleEnabled && !settings.googleEnabled : next.microsoftEnabled && !settings.microsoftEnabled;
      if (turningOn && !ssoProviderAvailable(env, provider)) {
        return jsonError(`${ENDPOINTS[provider].label} sign-in is not set up on this platform yet`, 409, jsonHeaders);
      }
    }
    const before = describeSettings(settings);
    const after = describeSettings(next);
    if (before !== after) {
      await db
        .prepare(
          `INSERT INTO sso_settings (tenant_id, google_enabled, google_domains, microsoft_enabled, microsoft_tenants, require_sso, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET
             google_enabled = excluded.google_enabled, google_domains = excluded.google_domains,
             microsoft_enabled = excluded.microsoft_enabled, microsoft_tenants = excluded.microsoft_tenants,
             require_sso = excluded.require_sso, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
        )
        .bind(
          tenant.id,
          next.googleEnabled ? 1 : 0,
          JSON.stringify(next.googleDomains),
          next.microsoftEnabled ? 1 : 0,
          JSON.stringify(next.microsoftTenants),
          next.requireSso ? 1 : 0,
          now(),
          session!.role === "super_admin" ? null : session!.user_id
        )
        .run();
      await writeAuditLog(db, { tenantId: tenant.id, userId: session!.user_id, action: "settings.sso", details: after });
    }
    settings = next;
  }
  return new Response(
    JSON.stringify({
      status: "ok",
      canEdit,
      redirectUri: ssoRedirectUri(env, request, isDev),
      google: { available: ssoProviderAvailable(env, "google"), enabled: settings.googleEnabled, domains: settings.googleDomains },
      microsoft: { available: ssoProviderAvailable(env, "microsoft"), enabled: settings.microsoftEnabled, tenants: settings.microsoftTenants },
      requireSso: settings.requireSso,
      // Whether the requirement is in force now: a provider is on and offered.
      requireSsoInForce: settings.requireSso && offeredProviders(env, settings).length > 0
    }),
    { headers: jsonHeaders }
  );
}

// ------------------------------------------------------- ID token checking

export class SsoError extends Error {
  constructor(readonly reason: string, message?: string) {
    super(message || reason);
  }
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new SsoError("malformed", "Not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function toBase64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function decodeJson(part: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  } catch (err) {
    if (err instanceof SsoError) throw err;
    throw new SsoError("malformed", "Not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SsoError("malformed", "Not a JSON object");
  return value as Record<string, unknown>;
}

/** What a verified ID token says about the person. */
export interface SsoIdentity {
  provider: SsoProvider;
  email: string;
  subject: string;
  /** Google: the Workspace domain. */
  hd?: string;
  /** Microsoft: the Entra tenant id. */
  tid?: string;
}

export interface IdTokenExpectations {
  provider: SsoProvider;
  clientId: string;
  nonce: string;
  /** Lower-case Google Workspace domains the account must belong to. */
  googleDomains: string[];
  /** Lower-case Entra tenant ids the account must belong to. */
  microsoftTenants: string[];
  nowSeconds?: number;
}

/** Finds the signing key a token names; null when the provider has no such key. */
export type SigningKeyResolver = (provider: SsoProvider, kid: string) => Promise<JsonWebKey | null>;

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/**
 * Verify an ID token: RS256 signature by a key the provider publishes, then
 * issuer, audience, times, nonce and the organization's directory. Throws
 * SsoError with a short reason; never returns an identity it did not check.
 */
export async function verifyIdToken(idToken: string, expect: IdTokenExpectations, resolveKey: SigningKeyResolver): Promise<SsoIdentity> {
  if (typeof idToken !== "string" || idToken.length > MAX_ID_TOKEN_LENGTH) throw new SsoError("malformed", "No usable ID token");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new SsoError("malformed", "An ID token has three parts");
  const header = decodeJson(parts[0]);
  if (header.alg !== "RS256") throw new SsoError("algorithm", `Algorithm ${String(header.alg)} is not accepted`);
  if (typeof header.kid !== "string" || !header.kid || header.kid.length > 256) throw new SsoError("unknown_key", "The token names no key");

  const jwk = await resolveKey(expect.provider, header.kid);
  if (!jwk || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new SsoError("unknown_key", "The provider publishes no such key");
  if ((jwk.alg && jwk.alg !== "RS256") || (jwk.use && jwk.use !== "sig")) throw new SsoError("unknown_key", "That key is not for RS256 signatures");
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch (err) {
    throw new SsoError("unknown_key", `The provider's key could not be read: ${(err as Error).message}`);
  }
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(parts[2]), signed);
  if (!valid) throw new SsoError("signature", "The signature does not verify");

  const claims = decodeJson(parts[1]);
  const at = expect.nowSeconds ?? now();

  // Audience: this platform's client. With several audiences, `azp` must name it too (OIDC Core 3.1.3.7).
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expect.clientId)) throw new SsoError("audience", "The token is for another application");
  if (audiences.length > 1 && claims.azp !== expect.clientId) throw new SsoError("audience", "The token was issued to another party");

  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < at) throw new SsoError("expired", "The token has expired");
  if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SECONDS > at) throw new SsoError("issued_later", "The token was issued in the future");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - CLOCK_SKEW_SECONDS > at)) throw new SsoError("not_yet_valid", "The token is not valid yet");
  if (typeof claims.nonce !== "string" || !timingSafeEqual(claims.nonce, expect.nonce)) throw new SsoError("nonce", "The token was not made for this sign-in");
  if (typeof claims.sub !== "string" || !claims.sub) throw new SsoError("malformed", "The token names no account");

  if (expect.provider === "google") {
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new SsoError("issuer", "The token is not Google's");
    // Google says whether it verified the address; a Workspace account's always is.
    if (claims.email_verified !== true && claims.email_verified !== "true") throw new SsoError("email_unverified", "Google has not verified this email address");
    const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
    if (!hd || !expect.googleDomains.includes(hd)) throw new SsoError("directory", "The account is not in one of the organization's Google Workspace domains");
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!EMAIL_PATTERN.test(email)) throw new SsoError("no_email", "The token carries no email address");
    return { provider: "google", email, subject: claims.sub, hd };
  }

  // Microsoft: the issuer names the account's own directory, and that directory must be one the organization listed.
  const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
  if (!TENANT_ID_PATTERN.test(tid)) throw new SsoError("issuer", "The token names no Entra tenant");
  if (claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new SsoError("issuer", "The token is not from that Entra tenant");
  if (!expect.microsoftTenants.includes(tid)) throw new SsoError("directory", "The account is not in one of the organization's Entra tenants");
  // Microsoft documents `email` as unverified across tenants: it is whatever the directory's
  // administrators typed. It is trusted here only because the tenant is one this organization
  // listed as its own. `preferred_username` (the UPN for a work account) is used only when no
  // `email` is issued -- an account without a mailbox -- and only when it has the shape of an
  // address: it comes from the same directory, under the same trust, and still has to match an
  // existing staff account's email exactly.
  const email = (typeof claims.email === "string" && claims.email.trim()) ? claims.email.trim().toLowerCase() : typeof claims.preferred_username === "string" ? claims.preferred_username.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(email)) throw new SsoError("no_email", "The token carries no email address");
  return { provider: "microsoft", email, subject: claims.sub, tid };
}

// ------------------------------------------------- the providers' signing keys

/** How long a provider's key set is used before it is read again. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** The least time between two reads of one provider's key set when a token names a key it lacks. */
const JWKS_REFETCH_MS = 60 * 1000;
const jwksCache = new Map<SsoProvider, { keys: JsonWebKey[]; fetchedAt: number }>();

/** Drop the cached key sets (tests, and nothing else, need a cold start). */
export function forgetSigningKeys(): void {
  jwksCache.clear();
}

/**
 * The provider's key with this `kid`, from a per-isolate cache that is read
 * again after an hour, or sooner when a token names a key it does not hold
 * (the provider rotated), but never more than once a minute: a stream of forged
 * tokens with made-up key ids must not turn into a stream of fetches.
 */
export async function providerSigningKey(provider: SsoProvider, kid: string, fetcher: typeof fetch = fetch, nowMs = Date.now()): Promise<JsonWebKey | null> {
  const find = (keys: JsonWebKey[]) => keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === kid) || null;
  const cached = jwksCache.get(provider);
  if (cached && nowMs - cached.fetchedAt < JWKS_TTL_MS) {
    const hit = find(cached.keys);
    if (hit || nowMs - cached.fetchedAt < JWKS_REFETCH_MS) return hit;
  }
  let keys: JsonWebKey[];
  try {
    const res = await fetcher(ENDPOINTS[provider].jwks, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error("no keys array");
    keys = body.keys.filter((k): k is JsonWebKey => Boolean(k) && typeof k === "object");
  } catch (err) {
    // A stale set beats none while the provider is unreachable.
    if (cached) {
      console.error(`[SSO] Reading ${ENDPOINTS[provider].label}'s signing keys failed; using the cached set:`, err);
      return find(cached.keys);
    }
    throw new SsoError("keys_unavailable", `${ENDPOINTS[provider].label}'s signing keys could not be read: ${(err as Error).message}`);
  }
  jwksCache.set(provider, { keys, fetchedAt: nowMs });
  return find(keys);
}

// ----------------------------------------------------------------- the flow

interface StateRow {
  state_hash: string;
  tenant_id: string;
  provider: SsoProvider;
  code_verifier: string;
  nonce: string;
  redirect_uri: string;
  return_origin: string;
  browser_hash: string;
  used_at: number | null;
  user_id: string | null;
  handoff_hash: string | null;
  created_at: number;
  expires_at: number;
}

export async function purgeExpiredSsoStates(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM sso_states WHERE expires_at < ?").bind(now()).run();
}

function browserCookie(value: string, secure: boolean, maxAge: number): string {
  // Host-only and Strict: read only by the redeem step on the sign-in page's own host.
  const parts = [`${BROWSER_COOKIE}=${value}`, "Path=/api/auth/sso", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Strict"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function browserTokenFrom(request: Request): string | null {
  const value = parseCookies(request.headers.get("Cookie"))[BROWSER_COOKIE] || "";
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** The sign-in page to send the browser back to, with one parameter added. */
function signInPage(returnOrigin: string, tenantSlug: string, param: "sso" | "sso_error", value: string): string {
  return `${returnOrigin}/?login=1&tenant=${encodeURIComponent(tenantSlug)}&${param}=${encodeURIComponent(value)}`;
}

function redirect(location: string, extraCookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const cookie of extraCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/**
 * Where the browser started, if this host may be returned to: the platform's
 * own host, or this organization's subdomain or custom domain. On a dev host,
 * the request's own origin.
 */
function returnOriginFor(env: Env, request: Request, tenant: Tenant, isDev: boolean): string | null {
  if (isDev) return new URL(request.url).origin;
  const host = hostname(request);
  const base = (env.DEFAULT_DOMAIN || "").replace(/^\./, "").toLowerCase();
  const allowed = new Set([base, `${tenant.subdomain}.${base}`.toLowerCase()]);
  if (tenant.custom_domain) allowed.add(tenant.custom_domain.toLowerCase());
  const canonical = canonicalHost(env);
  if (canonical) allowed.add(canonical.toLowerCase());
  return base && allowed.has(host) ? `https://${host}` : null;
}

/**
 * GET /api/auth/sso/start?provider=google|microsoft. The organization is the
 * one the sign-in page shows (its host, or ?tenant= on the platform host).
 */
export async function handleSsoStart(ctx: RouteContext, tenant: Tenant | null, secureCookies: boolean): Promise<Response> {
  const { db, env, request, url, jsonHeaders, clientIp, isDev } = ctx;
  const provider = url.searchParams.get("provider");
  if (!isSsoProvider(provider)) return jsonError("provider is google or microsoft", 400, jsonHeaders);
  if (!tenant) return jsonError("No organization selected for this sign-in", 400, jsonHeaders);
  const returnOrigin = returnOriginFor(env, request, tenant, isDev);
  if (!returnOrigin) return jsonError("Single sign-on starts on the organization's sign-in page", 400, jsonHeaders);
  const credentials = clientCredentials(env, provider);
  const settings = await getSsoSettings(db, tenant.id);
  if (tenant.status !== "active" || !credentials || !enabledIn(settings, provider)) {
    return redirect(signInPage(returnOrigin, tenant.subdomain, "sso_error", "unavailable"));
  }
  const redirectUri = ssoRedirectUri(env, request, isDev);
  if (!redirectUri) return jsonError("DEFAULT_DOMAIN is not set, so there is no sign-in callback", 503, jsonHeaders);

  const limiterKey = `sso:${clientIp}`;
  const wait = await rateLimitWait(db, limiterKey, START_LIMIT.perAddress, START_LIMIT.windowSeconds);
  if (wait > 0) return jsonError(`Too many sign-ins from this address. Try again in ${Math.ceil(wait / 60)} minute(s).`, 429, jsonHeaders);
  await recordRateLimitHit(db, limiterKey, START_LIMIT.windowSeconds);

  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const challenge = toBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  // One cookie per browser, kept across sign-ins so two tabs do not undo each other.
  const browser = browserTokenFrom(request) || bufferToHex(crypto.getRandomValues(new Uint8Array(32)));
  const ts = now();
  await db
    .prepare(
      `INSERT INTO sso_states (state_hash, tenant_id, provider, code_verifier, nonce, redirect_uri, return_origin, browser_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(await sha256Hex(state), tenant.id, provider, verifier, nonce, redirectUri, returnOrigin, await sha256Hex(browser), ts, ts + STATE_SECONDS)
    .run();

  const target = new URL(ENDPOINTS[provider].authorize);
  target.searchParams.set("client_id", credentials.id);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", nonce);
  target.searchParams.set("code_challenge", challenge);
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("prompt", "select_account");
  // A hint for Google's account chooser; the domain is enforced on the ID token, not here.
  if (provider === "google" && settings.googleDomains.length === 1) target.searchParams.set("hd", settings.googleDomains[0]);
  return redirect(target.toString(), [browserCookie(browser, secureCookies, STATE_SECONDS)]);
}

/** Exchange the authorization code for the ID token, proving the PKCE verifier. */
async function exchangeCode(provider: SsoProvider, credentials: { id: string; secret: string }, row: StateRow, code: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: row.redirect_uri,
    client_id: credentials.id,
    client_secret: credentials.secret,
    code_verifier: row.code_verifier
  });
  let res: Response;
  try {
    res = await fetch(ENDPOINTS[provider].token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
    });
  } catch (err) {
    throw new SsoError("token_exchange", `${ENDPOINTS[provider].label} could not be reached: ${(err as Error).message}`);
  }
  let data: { id_token?: unknown; error?: unknown; error_description?: unknown };
  try {
    data = await res.json();
  } catch {
    throw new SsoError("token_exchange", `${ENDPOINTS[provider].label} answered HTTP ${res.status} without JSON`);
  }
  if (!res.ok || typeof data.id_token !== "string") {
    throw new SsoError("token_exchange", `${ENDPOINTS[provider].label} refused the code: HTTP ${res.status} ${String(data.error || "")} ${String(data.error_description || "").slice(0, 200)}`);
  }
  return data.id_token;
}

/**
 * The account a verified email signs in to, in this organization: its owner or
 * a member of its staff, never the platform's super admin. Null otherwise.
 */
async function matchAccount(db: D1Database, tenant: Tenant, email: string): Promise<User | null> {
  const user = await findUserByEmail(db, email);
  if (!user || user.role === "super_admin") return null;
  if (tenant.user_id === user.id) return user;
  const member = await db.prepare("SELECT 1 FROM tenant_users WHERE tenant_id = ? AND user_id = ?").bind(tenant.id, user.id).first();
  return member ? user : null;
}

async function loadTenant(db: D1Database, id: string): Promise<Tenant | null> {
  return db.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<Tenant>();
}

/** A callback that cannot say which sign-in page it belongs to ends on this host's. */
function failurePage(message: string, htmlHeaders: Record<string, string>): Response {
  return new Response(
    renderStatusPageHtml({ title: "Sign-in not completed", heading: "Sign-in not completed", messageHtml: escapeHtml(message), homeHref: "/?login=1", tone: "warning" }),
    { status: 400, headers: { ...htmlHeaders, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }
  );
}

/** GET /api/auth/sso/callback: the provider sends the browser back here, on the platform host. */
export async function handleSsoCallback(ctx: RouteContext, htmlHeaders: Record<string, string>): Promise<Response> {
  const { db, env, request, url } = ctx;
  const host = (request.headers.get("host") || url.host).toLowerCase();
  const state = url.searchParams.get("state") || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return failurePage("This sign-in link is not complete. Start again from your organization's sign-in page.", htmlHeaders);

  // Spent by the first visit, right or wrong.
  const ts = now();
  const row = await db
    .prepare("UPDATE sso_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at >= ? RETURNING *")
    .bind(ts, await sha256Hex(state), ts)
    .first<StateRow>();
  if (!row) return failurePage("This sign-in has expired or was already used. Start again from your organization's sign-in page.", htmlHeaders);
  const callbackHost = new URL(row.redirect_uri).host.toLowerCase();
  if (host !== callbackHost) {
    await db.prepare("DELETE FROM sso_states WHERE state_hash = ?").bind(row.state_hash).run();
    return failurePage("This sign-in came back to the wrong address. Start again from your organization's sign-in page.", htmlHeaders);
  }

  const tenant = await loadTenant(db, row.tenant_id);
  const fail = async (reason: string, detail: string) => {
    await db.prepare("DELETE FROM sso_states WHERE state_hash = ?").bind(row.state_hash).run();
    console.warn(`[SSO] ${ENDPOINTS[row.provider].label} sign-in to tenant ${row.tenant_id} refused (${reason}): ${detail}`);
    return redirect(signInPage(row.return_origin, tenant?.subdomain || "", "sso_error", reason));
  };
  if (!tenant || tenant.status !== "active") return fail("unavailable", "the organization is not active");

  const providerError = url.searchParams.get("error");
  if (providerError) return fail(providerError === "access_denied" ? "cancelled" : "provider", `the provider answered ${providerError.slice(0, 80)}`);
  const code = url.searchParams.get("code") || "";
  if (!code || code.length > 4096) return fail("provider", "no authorization code");

  const credentials = clientCredentials(env, row.provider);
  const settings = await getSsoSettings(db, tenant.id);
  if (!credentials || !enabledIn(settings, row.provider)) return fail("unavailable", "the provider was turned off during the sign-in");

  let identity: SsoIdentity;
  try {
    const idToken = await exchangeCode(row.provider, credentials, row, code);
    identity = await verifyIdToken(
      idToken,
      { provider: row.provider, clientId: credentials.id, nonce: row.nonce, googleDomains: settings.googleDomains, microsoftTenants: settings.microsoftTenants },
      (p, kid) => providerSigningKey(p, kid)
    );
  } catch (err) {
    if (err instanceof SsoError) {
      const reason = err.reason === "token_exchange" || err.reason === "keys_unavailable" ? "provider" : err.reason === "directory" ? "directory" : "identity";
      return fail(reason, err.message);
    }
    throw err;
  }

  if ((await getLockoutRemaining(db, identity.email)) > 0) return fail("locked", "the account is locked after failed sign-ins");
  const user = await matchAccount(db, tenant, identity.email);
  if (!user) {
    await recordLoginFailure(db, identity.email);
    return fail("no_account", "no staff account of this organization has that email address");
  }

  const handoff = bufferToHex(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("UPDATE sso_states SET user_id = ?, handoff_hash = ?, expires_at = ? WHERE state_hash = ?")
    .bind(user.id, await sha256Hex(handoff), now() + HANDOFF_SECONDS, row.state_hash)
    .run();
  return redirect(signInPage(row.return_origin, tenant.subdomain, "sso", handoff));
}

/**
 * POST /api/auth/sso/redeem { code }: the sign-in page hands back what the
 * callback gave it. Answers exactly as POST /api/auth/login does.
 */
export async function handleSsoRedeem(ctx: RouteContext, cookies: CookieOptions, redirectFor: (tenant: Tenant) => string): Promise<Response> {
  const { db, request, url, jsonHeaders } = ctx;
  const host = (request.headers.get("host") || url.host).toLowerCase();
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return jsonError("Cross-site requests are not accepted", 403, jsonHeaders);
    }
    if (originHost !== host) return jsonError("Cross-site requests are not accepted", 403, jsonHeaders);
  }
  let body: { code?: unknown };
  try {
    body = await request.json<typeof body>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const code = typeof body?.code === "string" ? body.code : "";
  if (!/^[0-9a-f]{64}$/.test(code)) return jsonError("The sign-in code is not valid", 400, jsonHeaders);

  const expired = () => jsonError("This sign-in has expired. Start again.", 401, jsonHeaders);
  // Spent by the first attempt, whatever the checks below decide.
  const row = await db.prepare("DELETE FROM sso_states WHERE handoff_hash = ? RETURNING *").bind(await sha256Hex(code)).first<StateRow>();
  if (!row || !row.user_id || row.expires_at < now()) return expired();
  if (new URL(row.return_origin).host.toLowerCase() !== host) return expired();
  const browser = browserTokenFrom(request);
  if (!browser || !timingSafeEqual(await sha256Hex(browser), row.browser_hash)) return expired();

  const tenant = await loadTenant(db, row.tenant_id);
  if (!tenant || tenant.status !== "active") return jsonError("This organization's console is not available", 403, jsonHeaders);
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first<User>();
  // The account may have been removed or locked in the two minutes since the callback.
  const member = user ? await matchAccount(db, tenant, user.email) : null;
  if (!user || !member) return expired();
  const lockedFor = await getLockoutRemaining(db, user.email);
  if (lockedFor > 0) return jsonError(`Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`, 429, jsonHeaders);
  await clearLoginFailures(db, user.email);

  await writeAuditLog(db, { tenantId: tenant.id, userId: user.id, action: "auth.sso", details: `provider=${row.provider}` });
  const answer = await continueSignIn(ctx, cookies, { userId: user.id, tenantId: tenant.id, role: user.role, redirect: redirectFor(tenant) });
  const headers = new Headers(answer.headers);
  headers.append("Set-Cookie", browserCookie("", cookies.secure, 0));
  return new Response(answer.body, { status: answer.status, headers });
}
