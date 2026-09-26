/**
 * Authorization & Tenant Resolution
 *
 * Single source of truth for "who is asking" and "which organization are they allowed
 * to ask about". No route may derive a tenant or an identity on its own.
 */

import { Session, Tenant, DeviceToken } from "./types";
import {
  findTenantBySubdomain,
  findTenantByCustomDomain,
  findTenantById,
  findDeviceByToken,
  touchDeviceToken,
  getTenantUserPermissions
} from "./db";
import { cleanSubdomain } from "./escape";
import { DEMO_SLUGS, isDemoTenant } from "./demo";

/** Hostnames where the ?tenant= / X-Tenant override is trusted (local dev & tests). */
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal", "host.containers.internal"]);

/**
 * The host this request was addressed to.
 * Prefers the Host header, falling back to the request URL so the same logic
 * applies to directly-constructed Request objects (tests, service bindings).
 */
export function hostname(request: Request): string {
  const header = request.headers.get("host");
  if (header) {
    if (header.startsWith("[")) {
      const closing = header.indexOf("]");
      if (closing !== -1) return header.slice(0, closing + 1).toLowerCase();
    }
    return header.split(":")[0].toLowerCase();
  }
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return "localhost";
  }
}

/**
 * True when the request was addressed to a local development host.
 *
 * Loopback and RFC 1918 addresses count, because `pnpm dev` listens on
 * 0.0.0.0 and the workstation simulator (or a phone on the organization LAN) reaches
 * it by the machine's LAN address. A deployed worker never sees such a Host:
 * Cloudflare routes a request to it only by a configured hostname.
 */
export function isDevHost(request: Request): boolean {
  const host = hostname(request);
  if (DEV_HOSTS.has(host)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function jsonError(message: string, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

/** True when the host is a bare IP literal rather than a domain name. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/** Reserved subdomains that cannot be claimed or resolved as an organization tenant. */
const RESERVED_SLUGS = new Set([
  "www",
  "super",
  "labkiosk",
  "api",
  "admin",
  "portal",
  "status",
  "mail",
  "app",
  "kiosk",
  "root"
]);

/**
 * Names no organization may claim, though they still resolve: the three demos,
 * and `demo`, retired by migration 0013 and kept so nobody can register it and
 * pass as the platform's demonstration.
 */
const PLATFORM_SLUGS = new Set<string>(["demo", ...DEMO_SLUGS]);

/** True for slugs no organization may register or be given. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug) || PLATFORM_SLUGS.has(slug);
}

/** True when `host` is `base` itself or a subdomain of it (dot-anchored, unlike endsWith). */
export function isHostUnder(host: string, base: string | undefined): boolean {
  if (!base) return false;
  const cleanHost = host.toLowerCase();
  const cleanBase = base.replace(/^\./, "").toLowerCase();
  return cleanHost === cleanBase || cleanHost.endsWith("." + cleanBase);
}

/**
 * The organization slug carried by the Host header, or null when the host carries none.
 *
 * When `baseDomain` is configured the host must be exactly `<slug>.<baseDomain>`.
 * Without that anchor any multi-label host gets its first label read as an organization:
 * `host.docker.internal` becomes the organization "host", and a worker deployed to
 * `my-worker.someone.workers.dev` serves its own root as the organization "my-worker".
 * An IP literal has dot-separated parts but no subdomain either.
 */
export function hostSubdomain(request: Request, baseDomain?: string): string | null {
  const host = hostname(request);
  if (isIpLiteral(host)) return null;

  let slug: string;
  if (baseDomain) {
    const suffix = "." + baseDomain.replace(/^\./, "").toLowerCase();
    if (!host.endsWith(suffix)) return null;
    const prefix = host.slice(0, -suffix.length);
    // Only a single label counts; `a.b.labkiosk.akbhoi.com` is not the organization "a".
    if (!prefix || prefix.includes(".")) return null;
    slug = cleanSubdomain(prefix);
  } else {
    const parts = host.split(".");
    if (parts.length <= 2) return null;
    slug = cleanSubdomain(parts[0]);
  }

  if (!slug || RESERVED_SLUGS.has(slug)) return null;
  return slug;
}

/**
 * Resolve the tenant a request is acting on.
 *
 * The Host header is authoritative. `?tenant=` / `X-Tenant` are honoured only
 * when the caller demonstrably may target that tenant:
 *   - the request arrives on a local development host, or
 *   - the caller is the platform super admin, or
 *   - the caller's own session already belongs to that tenant, or
 *   - the route is a public, read-only one (`allowAnonymousOverride`) such as
 *     the user portal and the setup-wizard status probe, which must work
 *     before any session exists.
 *
 * A named tenant the caller may not act on resolves to `denied`, so the route
 * can answer 403 rather than a misleading "no organization selected".
 */
export interface TenantResolution {
  tenant: Tenant | null;
  /** True when a tenant was explicitly named but the caller may not act on it. */
  denied: boolean;
}

export async function resolveTenant(options: {
  db: D1Database;
  request: Request;
  url: URL;
  session: Session | null;
  allowAnonymousOverride?: boolean;
  baseDomain?: string;
}): Promise<TenantResolution> {
  const { db, request, url, session, allowAnonymousOverride = false, baseDomain } = options;

  // 1. Host header is authoritative in production.
  const slug = hostSubdomain(request, baseDomain);
  if (slug) {
    return { tenant: await findTenantBySubdomain(db, slug), denied: false };
  }

  // 1b. Check if the Host header matches an approved custom domain.
  const host = hostname(request);
  if (!isDevHost(request) && (!baseDomain || (host !== baseDomain && !host.endsWith("." + baseDomain)))) {
    const customTenant = await findTenantByCustomDomain(db, host);
    if (customTenant) {
      return { tenant: customTenant, denied: false };
    }
  }

  // 2. Explicit override, honoured only where trusted.
  const requested = cleanSubdomain(url.searchParams.get("tenant") ?? request.headers.get("x-tenant") ?? "");
  if (requested) {
    const candidate = await findTenantBySubdomain(db, requested);
    if (!candidate) return { tenant: null, denied: false };

    const mayOverride =
      isDevHost(request) ||
      allowAnonymousOverride ||
      session?.role === "super_admin" ||
      session?.tenant_id === candidate.id;

    return mayOverride ? { tenant: candidate, denied: false } : { tenant: null, denied: true };
  }

  // 3. Fall back to the tenant the session already belongs to.
  if (session?.tenant_id) {
    return { tenant: await findTenantById(db, session.tenant_id), denied: false };
  }

  return { tenant: null, denied: false };
}

/**
 * Defence in depth against cross-site request forgery.
 *
 * Session cookies are `SameSite=Lax`, which already keeps them off cross-site
 * POSTs in every current browser. This check backs that up: a browser always
 * sends `Origin` on a POST/DELETE, so a cookie-authenticated mutation whose
 * Origin is not this host, the platform domain or a dev host is refused.
 * Requests without an Origin header (curl, the Python agent, tests) are not
 * browser requests and pass; device routes authenticate with a bearer token
 * and never rely on a cookie in the first place.
 */
export function rejectCrossSiteMutation(
  request: Request,
  options: { usedCookie: boolean; baseDomain?: string },
  headers: Record<string, string>
): Response | null {
  if (!options.usedCookie) return null;
  if (request.method !== "POST" && request.method !== "DELETE") return null;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") {
    return origin === "null" ? jsonError("Cross-site requests are not accepted", 403, headers) : null;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return jsonError("Cross-site requests are not accepted", 403, headers);
  }
  // A dev-host origin is same-site only for a request that is itself on a dev
  // host. In production it would admit any page served from the operator's own
  // machine -- a local tool, or a malicious localhost server -- as this site.
  const sameSite =
    originHost === hostname(request) ||
    (DEV_HOSTS.has(originHost) && isDevHost(request)) ||
    isHostUnder(originHost, options.baseDomain);
  return sameSite ? null : jsonError("Cross-site requests are not accepted", 403, headers);
}

/**
 * A cookie-authenticated WebSocket handshake must come from this site.
 *
 * Browsers send cookies with a cross-site WebSocket handshake and CORS does not
 * apply to it, so without this any page could open the console's live channel
 * as a signed-in administrator. Browsers always send `Origin` on a handshake;
 * one without it is refused.
 */
export function rejectCrossSiteSocket(
  request: Request,
  options: { baseDomain?: string },
  headers: Record<string, string>
): Response | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return jsonError("Cross-site requests are not accepted", 403, headers);
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch (err) {
    console.warn("[Guard] Unparseable Origin on a WebSocket handshake:", err);
    return jsonError("Cross-site requests are not accepted", 403, headers);
  }
  const sameSite =
    originHost === hostname(request) ||
    (DEV_HOSTS.has(originHost) && isDevHost(request)) ||
    isHostUnder(originHost, options.baseDomain);
  return sameSite ? null : jsonError("Cross-site requests are not accepted", 403, headers);
}

/** 403 unless the session is the platform super admin. */
export function requireSuperAdmin(session: Session | null, headers: Record<string, string>): Response | null {
  if (!session) return jsonError("Authentication required", 401, headers);
  if (session.role !== "super_admin") return jsonError("Super administrator access required", 403, headers);
  return null;
}

/**
 * 403 unless the session administers this tenant. A platform super admin may open
 * only the demo organizations it owns (Rule 2), so the platform can be tested
 * without reaching into a real organization's data.
 */
export function requireTenantAdmin(
  session: Session | null,
  tenant: Tenant | null,
  headers: Record<string, string>
): Response | null {
  if (!session) return jsonError("Authentication required", 401, headers);
  if (!tenant) return jsonError("No organization selected for this request", 400, headers);

  if (session.role === "super_admin") {
    if (isDemoTenant(tenant, session.user_id)) return null;
    return jsonError("Platform administrators cannot access individual organization consoles for privacy and security", 403, headers);
  }

  if (session.tenant_id !== tenant.id) {
    return jsonError("You do not have access to this organization", 403, headers);
  }
  return null;
}

/** 403 unless the session holds the specified permission for this tenant. */
export async function requireTenantPermission(
  db: D1Database,
  session: Session | null,
  tenant: Tenant | null,
  permission: string,
  headers: Record<string, string>
): Promise<Response | null> {
  const adminDenied = requireTenantAdmin(session, tenant, headers);
  if (adminDenied) return adminDenied;

  // A super admin who got past requireTenantAdmin is in one of its own demos.
  if (session!.role === "super_admin") return null;

  // Primary owner of the tenant has all permissions
  if (tenant!.user_id === session!.user_id) return null;

  // Check granular permissions for delegated sub-admins / operators
  const perms = await getTenantUserPermissions(db, tenant!.id, session!.user_id);
  if (!perms.includes(permission) && !perms.includes("*")) {
    return jsonError(`You do not have permission to access ${permission}`, 403, headers);
  }
  return null;
}

export interface DeviceAuthResult {
  device: DeviceToken;
  error?: undefined;
}
export interface DeviceAuthFailure {
  device?: undefined;
  error: Response;
}

/**
 * Verified device tokens, per isolate, for a minute.
 *
 * A workstation on the HTTP heartbeat presents its token every 3 seconds, and
 * looking it up in D1 each time was a query per heartbeat. A removed
 * workstation is still refused at once: its organization's OrgHub keeps its own
 * list of removed machines, and `forgetDeviceToken` clears this isolate's copy.
 */
const DEVICE_TOKEN_CACHE_MS = 60_000;
const DEVICE_TOKEN_CACHE_LIMIT = 20_000;
/** A token's last-used time is written at most this often. */
const DEVICE_TOKEN_TOUCH_SECONDS = 3600;
const deviceTokenCache = new Map<string, { device: DeviceToken; until: number }>();

/** Drop this isolate's cached tokens for a workstation (it was removed or re-enrolled). */
export function forgetDeviceToken(tenantId: string, clientId: string): void {
  for (const [token, entry] of deviceTokenCache) {
    if (entry.device.tenant_id === tenantId && entry.device.client_id === clientId) deviceTokenCache.delete(token);
  }
}

/**
 * Authenticate an enrolled workstation by its bearer token.
 * The token, not the request body, decides which tenant and which client id the
 * caller may act as.
 */
export async function requireDevice(
  request: Request,
  db: D1Database,
  headers: Record<string, string>
): Promise<DeviceAuthResult | DeviceAuthFailure> {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return { error: jsonError("Device token required", 401, headers) };
  }

  const token = auth.substring(7).trim();
  if (!token) {
    return { error: jsonError("Device token required", 401, headers) };
  }

  const now = Date.now();
  const cached = deviceTokenCache.get(token);
  if (cached && cached.until > now) return { device: cached.device };

  const device = await findDeviceByToken(db, token);
  if (!device || device.revoked) {
    deviceTokenCache.delete(token);
    return { error: jsonError("Invalid or revoked device token", 401, headers) };
  }

  if (Math.floor(now / 1000) - Number(device.last_used_at || 0) > DEVICE_TOKEN_TOUCH_SECONDS) {
    await touchDeviceToken(db, device.id);
  }
  if (deviceTokenCache.size >= DEVICE_TOKEN_CACHE_LIMIT) {
    const oldest = deviceTokenCache.keys().next().value;
    if (oldest !== undefined) deviceTokenCache.delete(oldest);
  }
  deviceTokenCache.set(token, { device, until: now + DEVICE_TOKEN_CACHE_MS });
  return { device };
}
