/**
 * Search engines and website analytics.
 *
 * Only the platform's own public pages belong in a search index: the landing
 * page and the legal pages, on the canonical host. Organization subdomains,
 * custom domains, the consoles, the User Portal and the workers.dev address are
 * application surfaces, so every HTML response there carries
 * `X-Robots-Tag: noindex`.
 *
 * Google Analytics runs through Cloudflare Zaraz, which the zone injects into
 * HTML at the edge. The CSP lets its loader (`/cdn-cgi/zaraz/s.js`) run on the
 * public marketing pages of the platform host and nowhere else, so analytics
 * can never reach a workstation, a console or an organization's pages, even if
 * Zaraz is injected there.
 */

import { isDevHost, hostname } from "./guard";
import { escapeAttr } from "./escape";
import type { Env } from "./types";

/** Pages that may appear in search results, and that the sitemap lists. */
export const INDEXABLE_PATHS: readonly string[] = ["/", "/privacy", "/terms", "/terms/bug-reports"];

/**
 * Public pages where website analytics may run: the indexable pages plus the
 * landing page's dialog views. The Privacy Policy names exactly these.
 */
const ANALYTICS_PATHS = new Set<string>([...INDEXABLE_PATHS, "/login", "/register", "/download", "/iso", "/contact"]);

/** Zaraz's loader, which the inline snippet Cloudflare injects adds without a nonce. */
export const ZARAZ_LOADER_PATH = "/cdn-cgi/zaraz/s.js";

const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The host search engines should list the public pages under, or null when
 * DEFAULT_DOMAIN is unset (local development and the simulator, where no host
 * is canonical and none is substituted).
 *
 * `CANONICAL_HOST` names it when the zone redirects the apex elsewhere (labkiosk.org
 * redirects to www.labkiosk.org); otherwise it is the platform domain itself.
 * A value that is not a host name under DEFAULT_DOMAIN, or one set without
 * DEFAULT_DOMAIN, is a configuration error.
 */
export function canonicalHost(env: Env): string | null {
  const base = (env.DEFAULT_DOMAIN || "").replace(/^\./, "").toLowerCase();
  const configured = (env.CANONICAL_HOST || "").trim().toLowerCase();
  if (!base) {
    if (configured) throw new Error("CANONICAL_HOST is set but DEFAULT_DOMAIN is not; set DEFAULT_DOMAIN too");
    return null;
  }
  if (!configured) return base;
  if (!HOSTNAME_PATTERN.test(configured) || (configured !== base && !configured.endsWith("." + base))) {
    throw new Error(`CANONICAL_HOST "${configured}" must be ${base} or a host name under it`);
  }
  return configured;
}

/**
 * True for the hosts that serve the platform's public pages: the apex, www and
 * the canonical host. Without DEFAULT_DOMAIN only a development host qualifies.
 */
export function isPlatformHost(request: Request, env: Env): boolean {
  if (isDevHost(request)) return true;
  const canonical = canonicalHost(env);
  if (!canonical || !env.DEFAULT_DOMAIN) return false;
  const host = hostname(request);
  const base = env.DEFAULT_DOMAIN.replace(/^\./, "").toLowerCase();
  return host === base || host === `www.${base}` || host === canonical;
}

/**
 * The origin canonical links and the sitemap use. A development host, or a
 * deployment without DEFAULT_DOMAIN, keeps the request's own origin.
 */
export function siteOrigin(request: Request, url: URL, env: Env): string {
  const canonical = canonicalHost(env);
  return isDevHost(request) || !canonical ? url.origin : `https://${canonical}`;
}

/**
 * The canonical URL of a public page, or undefined for a page without one. The
 * legal pages answer on every host, so on an organization subdomain they point
 * search engines at the platform's copy; "/" there is the organization's own
 * homepage, which has none.
 */
export function canonicalUrlFor(request: Request, url: URL, env: Env): string | undefined {
  const path = url.pathname;
  if (!INDEXABLE_PATHS.includes(path)) return undefined;
  if (path === "/" && !isPlatformPublicPage(request, url, env)) return undefined;
  return `${siteOrigin(request, url, env)}${path}`;
}

/**
 * True when the request is for the platform's own public pages. `?tenant=`
 * turns the platform host's root into an organization's page, which is not.
 */
function isPlatformPublicPage(request: Request, url: URL, env: Env): boolean {
  return isPlatformHost(request, env) && !url.searchParams.has("tenant") && !request.headers.has("x-tenant");
}

/** True when this response may be indexed by a search engine. */
export function isIndexable(request: Request, url: URL, env: Env): boolean {
  return isPlatformPublicPage(request, url, env) && INDEXABLE_PATHS.includes(url.pathname);
}

/** True when website analytics may run on this response. */
export function allowsAnalytics(request: Request, url: URL, env: Env): boolean {
  return isPlatformPublicPage(request, url, env) && ANALYTICS_PATHS.has(url.pathname);
}

/** `<link rel="canonical">` for a page, or nothing when there is no canonical URL. */
export function canonicalLinkHtml(canonicalUrl: string | undefined): string {
  return canonicalUrl ? `  <link rel="canonical" href="${escapeAttr(canonicalUrl)}">\n` : "";
}

/** The site icon, also used by search results next to the page title. */
export const FAVICON_PATH = "/favicon.svg";

/** `<link rel="icon">` for the site icon. */
export const FAVICON_LINK_HTML = `  <link rel="icon" href="${FAVICON_PATH}" type="image/svg+xml">\n`;

/**
 * The brand mark (a monitor) on the accent colour. A standalone file, not
 * markup, so its colours are literal: it is drawn outside any page's tokens.
 */
export function faviconSvg(accent: string, foreground: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="${accent}"/><g transform="translate(9 9) scale(1.25)" fill="none" stroke="${foreground}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></g></svg>`;
}

/** The logo mail clients show beside the platform's email (BIMI, docs/DEPLOYMENT.md "Email"). */
export const BIMI_PATH = "/bimi.svg";

/**
 * The brand mark in the SVG Tiny Portable/Secure profile BIMI requires: a
 * square with a solid background (clients crop it to a circle), a title, and
 * nothing external or scripted.
 */
export function bimiSvg(accent: string, foreground: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 48 48"><title>Lab Kiosk</title><rect width="48" height="48" fill="${accent}"/><g transform="translate(9 9) scale(1.25)" fill="none" stroke="${foreground}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></g></svg>
`;
}

/**
 * robots.txt. The platform host lets crawlers in and names the sitemap; every
 * other host only keeps them off the API, so they can read the noindex header
 * on its pages (a page a crawler may not fetch can still be listed by URL).
 */
export function robotsTxt(request: Request, url: URL, env: Env): string {
  if (!isPlatformHost(request, env)) {
    return ["User-agent: *", "Disallow: /api/", ""].join("\n");
  }
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /admin",
    "Disallow: /super",
    "",
    `Sitemap: ${siteOrigin(request, url, env)}/sitemap.xml`,
    ""
  ].join("\n");
}

/** sitemap.xml listing the indexable pages on the canonical origin. */
export function sitemapXml(request: Request, url: URL, env: Env): string {
  const origin = siteOrigin(request, url, env);
  const entries = INDEXABLE_PATHS.map((path) => `  <url><loc>${escapeAttr(origin + path)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}
