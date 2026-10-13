/**
 * What a link on a page the platform hosts may point to: an organization
 * homepage block's link and a User Portal card (its address and thumbnail).
 *
 * safeHttpUrl() already keeps only http(s). On top of that the Content Policy
 * refuses links that hide their destination -- a bare IP address, a link
 * shortener, a user name or password in the address -- and any domain on the
 * platform's blocklist (link_blocklist), including its subdomains.
 */

/** Well-known link shorteners: a link through one hides where it goes. */
export const URL_SHORTENERS: readonly string[] = [
  "bit.ly",
  "bit.do",
  "buff.ly",
  "cutt.ly",
  "goo.gl",
  "is.gd",
  "ow.ly",
  "rb.gy",
  "rebrand.ly",
  "s.id",
  "shorturl.at",
  "t.co",
  "t.ly",
  "tiny.cc",
  "tinyurl.com",
  "v.gd"
];

/** A blocklist entry: a host name, lower case, no scheme, port or path. */
export const BLOCKLIST_DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface BlocklistEntry {
  domain: string;
  reason: string | null;
  added_at: number;
  added_by: string | null;
}

export async function listLinkBlocklist(db: D1Database): Promise<BlocklistEntry[]> {
  return (await db.prepare("SELECT domain, reason, added_at, added_by FROM link_blocklist ORDER BY domain").all<BlocklistEntry>()).results || [];
}

export async function addBlockedDomain(db: D1Database, domain: string, reason: string | null, userId: string): Promise<void> {
  if (!BLOCKLIST_DOMAIN_PATTERN.test(domain)) throw new Error(`${JSON.stringify(domain)} is not a domain name`);
  await db
    .prepare(
      `INSERT INTO link_blocklist (domain, reason, added_at, added_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET reason = excluded.reason, added_at = excluded.added_at, added_by = excluded.added_by`
    )
    .bind(domain, reason, Math.floor(Date.now() / 1000), userId)
    .run();
}

export async function removeBlockedDomain(db: D1Database, domain: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM link_blocklist WHERE domain = ?").bind(domain).run();
  return Number(res.meta?.changes ?? 0) > 0;
}

function within(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Why `url` (already through safeHttpUrl) may not be published on a hosted
 * page, or null when it may. `blocked` is the platform blocklist's domains.
 */
export function hostedLinkProblem(url: string, blocked: readonly string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The link is not a valid address";
  }
  if (parsed.username || parsed.password) return "A link may not carry a user name or password";
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (/^\[.*\]$/.test(host) || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return "Link to a site by its name, not by an IP address";
  }
  if (URL_SHORTENERS.some((s) => within(host, s))) return "Link shorteners hide where a link goes; use the full address instead";
  const hit = blocked.find((d) => within(host, d));
  if (hit) return `Links to ${hit} are not allowed on pages Lab Kiosk hosts`;
  return null;
}
