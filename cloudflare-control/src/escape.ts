/**
 * HTML / attribute / JSON escaping helpers.
 *
 * Every template in ui*.ts renders untrusted, tenant-supplied strings (school
 * names, admin emails, portal card titles and URLs). Nothing may be
 * interpolated into markup without passing through one of these.
 */

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/** Escape for HTML text nodes and for single- or double-quoted attribute values. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch]);
}

/** Alias kept for call-site readability when the target is an attribute. */
export const escapeAttr = escapeHtml;

/**
 * Serialize a value for inlining inside a <script> block.
 * Escapes the characters that would otherwise terminate the script element or
 * open an HTML comment, both of which let attacker data break out into markup.
 */
// U+2028 / U+2029 built from code points so this source file stays pure ASCII.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, "g");

export function escapeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEPARATORS, (ch) => (ch === String.fromCharCode(0x2028) ? "\\u2028" : "\\u2029"));
}

/**
 * Normalize a subdomain slug to the single canonical form used everywhere:
 * lowercase, trimmed, and restricted to letters, digits and hyphens.
 */
export function cleanSubdomain(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "");
}

/**
 * Return the URL only when it is a syntactically valid http(s) URL.
 * If no scheme is specified (e.g. canvas.institution.edu or 192.168.1.50:8080),
 * defaults to https:// for user convenience while strictly rejecting
 * non-http(s) schemes like javascript:, data:, file:, etc.
 */
export function safeHttpUrl(raw: unknown): string | null {
  const candidate = String(raw ?? "").trim();
  if (!candidate) return null;
  // `canvas.edu:8080` is a host and a port, not the scheme "canvas.edu:".
  const looksLikeHostPort = /^[a-zA-Z0-9.-]+:\d{1,5}(\/|$)/.test(candidate);
  const hasScheme = !looksLikeHostPort && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate);
  const toParse = hasScheme ? candidate : `https://${candidate}`;
  try {
    const parsed = new URL(toParse);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Normalize and validate a custom domain (FQDN):
 * lowercase, trimmed, no protocol, no path, valid hostname syntax with at least one dot.
 */
export function cleanCustomDomain(raw: unknown): string | null {
  const str = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (!str || str.length > 253) return null;
  // Must be valid domain labels separated by dots, e.g. kiosk.myschool.edu
  const domainPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!domainPattern.test(str)) return null;
  return str;
}

