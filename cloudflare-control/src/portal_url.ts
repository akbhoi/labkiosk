/**
 * The URL a workstation of an organization should open.
 *
 * It depends on how the workstation reached the control plane as much as on the
 * organization: a workstation may talk to a host that is not its organization's
 * own subdomain (the Docker simulator talks to a container gateway, a worker
 * deployed to `*.workers.dev` has no organization subdomain at all), and a bare
 * `${origin}/` would land such a kiosk on the public landing page.
 *
 * The request-dependent half is captured once as a `PortalContext`, so the
 * organization's Durable Object can compute the portal for a workstation long
 * after the request that connected it -- and again whenever the organization's
 * settings change -- without holding on to the request itself.
 */

import { Env, Tenant } from "./types";
import { safeHttpUrl } from "./escape";
import { hostname, hostSubdomain, isDevHost } from "./guard";

export interface PortalContext {
  /** Origin to build a portal address on: the Host header on a dev host, else the URL's origin. */
  origin: string;
  /** The request URL's own origin. */
  urlOrigin: string;
  isHttps: boolean;
  isDev: boolean;
  /** Host name the request arrived on, lower case, no port. */
  host: string;
  /** Organization slug the host names, if it is a subdomain of the platform domain. */
  hostSlug: string | null;
  /** The platform domain, e.g. `labkiosk.akbhoi.com`. */
  baseDomain: string;
}

/**
 * The origin a workstation's portal link should use. The Host header is the only
 * origin evidence honoured, and only on a dev host: a caller-supplied
 * X-Forwarded-Host would let anyone choose where a workstation is sent.
 */
export function effectiveOrigin(request: Request, url: URL): string {
  const host = request.headers.get("host");
  if (host && isDevHost(request)) {
    const proto = (request.headers.get("x-forwarded-proto") || url.protocol || "http:").replace(/:?$/, ":");
    return `${proto}//${host}`;
  }
  return url.origin;
}

export function requestIsHttps(request: Request, url: URL): boolean {
  return Boolean(
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    request.headers.get("cf-visitor")?.includes('"scheme":"https"')
  );
}

export function portalContextFrom(request: Request, url: URL, env: Env): PortalContext {
  return {
    origin: effectiveOrigin(request, url),
    urlOrigin: url.origin,
    isHttps: requestIsHttps(request, url),
    isDev: isDevHost(request),
    host: hostname(request),
    hostSlug: hostSubdomain(request, env.DEFAULT_DOMAIN),
    baseDomain: (env.DEFAULT_DOMAIN || "").replace(/^\./, "").toLowerCase()
  };
}

/** Is this value a portal context a Durable Object may trust? It was built by the Worker. */
export function isPortalContext(value: unknown): value is PortalContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.origin === "string" &&
    typeof v.urlOrigin === "string" &&
    typeof v.isHttps === "boolean" &&
    typeof v.isDev === "boolean" &&
    typeof v.host === "string" &&
    (v.hostSlug === null || typeof v.hostSlug === "string") &&
    typeof v.baseDomain === "string"
  );
}

export function portalUrlFromContext(tenant: Tenant, ctx: PortalContext): string {
  const homePath = tenant.home_route && tenant.home_route.startsWith("/") ? tenant.home_route : "/";
  const named = `${ctx.origin}${homePath === "/" ? "" : homePath}?tenant=${encodeURIComponent(tenant.subdomain)}`;

  if (tenant.mode === "single_url") {
    return safeHttpUrl(tenant.default_url) || named;
  }

  // Local dev or unencrypted HTTP: the local origin, so workstations and Docker
  // simulators can test without public DNS.
  if (!ctx.isHttps || ctx.isDev) {
    return named;
  }

  // Already on this organization's own subdomain or custom domain.
  if (
    ctx.hostSlug === tenant.subdomain ||
    (tenant.custom_domain && ctx.host === tenant.custom_domain.toLowerCase())
  ) {
    return `${ctx.urlOrigin}${homePath}`;
  }

  // An active custom domain is the canonical address for this organization.
  if (tenant.custom_domain) {
    return `https://${tenant.custom_domain}${homePath}`;
  }

  // Talking to the production domain, so the organization has a canonical address.
  if (ctx.baseDomain && (ctx.host === ctx.baseDomain || ctx.host.endsWith("." + ctx.baseDomain))) {
    return `https://${tenant.subdomain}.${ctx.baseDomain}${homePath}`;
  }

  // Reached on some other host (container gateway, workers.dev, a bare IP).
  return named;
}

export function portalUrlFor(tenant: Tenant, request: Request, url: URL, env: Env): string {
  return portalUrlFromContext(tenant, portalContextFrom(request, url, env));
}
