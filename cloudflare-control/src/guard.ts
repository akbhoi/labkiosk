/**
 * Authorization & Tenant Resolution
 *
 * Single source of truth for "who is asking" and "which school are they allowed
 * to ask about". No route may derive a tenant or an identity on its own.
 */

import { Session, Tenant, DeviceToken } from "./types";
import {
  findTenantBySubdomain,
  findTenantByCustomDomain,
  findTenantById,
  findDeviceByToken,
  touchDeviceToken
} from "./db";
import { cleanSubdomain } from "./escape";

/** Hostnames where the ?tenant= / X-Tenant override is trusted (local dev & tests). */
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal", "host.containers.internal"]);

/**
 * The host this request was addressed to.
 * Prefers the Host header, falling back to the request URL so the same logic
 * applies to directly-constructed Request objects (tests, service bindings).
 */
export function hostname(request: Request): string {
  const header = request.headers.get("host");
  if (header) return header.split(":")[0].toLowerCase();
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return "localhost";
  }
}

export function isDevHost(request: Request): boolean {
  return DEV_HOSTS.has(hostname(request));
}

export function jsonError(message: string, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

/** True when the host is a bare IP literal rather than a domain name. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/**
 * The school slug carried by the Host header, or null when the host carries none.
 *
 * When `baseDomain` is configured the host must be exactly `<slug>.<baseDomain>`.
 * Without that anchor any multi-label host gets its first label read as a school:
 * `host.docker.internal` becomes the school "host", and a worker deployed to
 * `my-worker.someone.workers.dev` serves its own root as the school "my-worker".
 * An IP literal has dot-separated parts but no subdomain either.
 */
/** Reserved subdomains that cannot be claimed or resolved as a school tenant. */
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

export function hostSubdomain(request: Request, baseDomain?: string): string | null {
  const host = hostname(request);
  if (isIpLiteral(host)) return null;

  let slug: string;
  if (baseDomain) {
    const suffix = "." + baseDomain.replace(/^\./, "").toLowerCase();
    if (!host.endsWith(suffix)) return null;
    const prefix = host.slice(0, -suffix.length);
    // Only a single label counts; `a.b.labkiosk.akbhoi.com` is not the school "a".
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
 *   - the route is a public, unauthenticated one (`allowAnonymousOverride`),
 *     such as the student portal and the setup-wizard status probe, which are
 *     read-only and must work before any session exists.
 */
/**
 * Resolve the tenant a request is acting on.
 *
 * The Host header is authoritative. `?tenant=` / `X-Tenant` are honoured only
 * when the caller demonstrably may target that tenant:
 *   - the request arrives on a local development host, or
 *   - the caller is the platform super admin, or
 *   - the caller's own session already belongs to that tenant, or
 *   - the route is a public, read-only one (`allowAnonymousOverride`) such as
 *     the student portal and the setup-wizard status probe, which must work
 *     before any session exists.
 *
 * A named tenant the caller may not act on resolves to `denied`, so the route
 * can answer 403 rather than a misleading "no school selected".
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

/** 403 unless the session is the platform super admin. */
export function requireSuperAdmin(session: Session | null, headers: Record<string, string>): Response | null {
  if (!session) return jsonError("Authentication required", 401, headers);
  if (session.role !== "super_admin") return jsonError("Super administrator access required", 403, headers);
  return null;
}

/** 403 unless the session administers this tenant (super admins may act on any). */
export function requireTenantAdmin(
  session: Session | null,
  tenant: Tenant | null,
  headers: Record<string, string>
): Response | null {
  if (!session) return jsonError("Authentication required", 401, headers);
  if (!tenant) return jsonError("No school selected for this request", 400, headers);
  if (session.role === "super_admin") return null;
  if (session.tenant_id !== tenant.id) {
    return jsonError("You do not have access to this school", 403, headers);
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

  const device = await findDeviceByToken(db, token);
  if (!device || device.revoked) {
    return { error: jsonError("Invalid or revoked device token", 401, headers) };
  }

  await touchDeviceToken(db, device.id);
  return { device };
}
