/**
 * Printing: the organization's network printers, and whether its workstations
 * may print at all.
 *
 * Off by default for every organization (tenants.printing_enabled, 0047). An
 * administrator holding `settings` turns it on in Settings -> Printing and lists
 * the printers by name and IPP address, each for every workstation or for one
 * workstation group. The organization's hub hands each workstation
 * `printing: { enabled, printers }` in its configuration, only the printers
 * meant for it, and its agent sets up a CUPS queue per printer (driverless,
 * IPP Everywhere) through the root helper labkiosk-printing. With printing off,
 * a workstation runs no print service at all and Chromium refuses to print.
 *
 * A printer address is checked here, again by the agent and again by the
 * helper: ipp:// or ipps:// only, to a host name or a private address, with a
 * plain path. Nothing in it reaches a shell, but a file:, usb: or loopback
 * address would hand a user something other than the organization's printer.
 */

/** The most printers one organization lists. */
export const MAX_PRINTERS = 20;
export const MAX_PRINTER_NAME_LENGTH = 64;
export const MAX_PRINTER_URI_LENGTH = 255;

/** A printer's id: 16 lower-case hex digits, also the workstation's queue name (labkiosk-<id>). */
export const PRINTER_ID_PATTERN = /^[0-9a-f]{16}$/;

export interface Printer {
  id: string;
  name: string;
  uri: string;
  /** Only the workstations in this group get it; null for every workstation. */
  groupName: string | null;
}

/** What one workstation is told (WorkstationConfig.printing). */
export interface WorkstationPrinting {
  enabled: boolean;
  printers: Array<{ id: string; name: string; uri: string }>;
}

interface PrinterRow {
  id: string;
  name: string;
  uri: string;
  group_name: string | null;
}

const URI_SHAPE = /^([Ii][Pp][Pp][Ss]?):\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(\/(?:[A-Za-z0-9._~\/-]|%[0-9A-Fa-f]{2})*)?$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_SHAPE = /^[0-9]+(?:\.[0-9]+){3}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Whether an IPv4 address is on a private network: 10/8, 172.16/12, 192.168/16, or link-local 169.254/16. */
function isPrivateIpv4(host: string): boolean | null {
  const octets = host.split(".").map((part) => (/^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : NaN));
  if (octets.length !== 4 || octets.some((n) => !(n >= 0 && n <= 255))) return null;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Whether a bracketed IPv6 address is a unique local one (fc00::/7); link-local needs a zone, which no URI here carries. */
function isUniqueLocalIpv6(bracketed: string): boolean {
  const address = bracketed.slice(1, -1).toLowerCase();
  if (!/^f[cd][0-9a-f]{0,2}:[0-9a-f:]*$/.test(address)) return false;
  try {
    return new URL(`http://[${address}]/`).hostname.startsWith("[f");
  } catch {
    return false;
  }
}

/** Why a printer address is refused, or null when it is a usable ipp:// or ipps:// address. */
export function printerUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "Every printer needs an address";
  const uri = raw.trim();
  if (uri.length > MAX_PRINTER_URI_LENGTH) return `A printer address is at most ${MAX_PRINTER_URI_LENGTH} characters`;
  const shape = URI_SHAPE.exec(uri);
  if (!shape) {
    return "A printer address is ipp:// or ipps:// followed by the printer's host name or private address and an optional port and path, such as ipp://printer.example.org/ipp/print";
  }
  const host = shape[2].toLowerCase();
  const port = shape[3];
  if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65535)) return "A printer's port is from 1 to 65535";
  if (host.startsWith("[")) {
    if (!isUniqueLocalIpv6(host)) return "An IPv6 printer address must be a unique local address (fc00::/7)";
    return null;
  }
  if (IPV4_SHAPE.test(host)) {
    const isPrivate = isPrivateIpv4(host);
    if (isPrivate === null) return "That is not an IPv4 address";
    if (!isPrivate) return "A printer's IP address must be on a private network (10.x, 172.16-31.x, 192.168.x or 169.254.x)";
    return null;
  }
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.length > 253 || !name.split(".").every((label) => HOST_LABEL.test(label))) return "That is not a host name";
  if (!/[a-z]/.test(name)) return "That is not a host name";
  if (name === "localhost" || name.endsWith(".localhost")) return "A printer cannot be on the workstation itself";
  return null;
}

/**
 * A valid address as it is stored and sent: trimmed, the scheme in lower case,
 * which is how CUPS names its backends and how the agent checks it.
 */
export function normalizePrinterUri(uri: string): string {
  const trimmed = uri.trim();
  const colon = trimmed.indexOf(":");
  return trimmed.slice(0, colon).toLowerCase() + trimmed.slice(colon);
}

/** Why a printer's display name is refused, or null. */
export function printerNameProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "Every printer needs a name";
  const name = raw.trim();
  if (name.length > MAX_PRINTER_NAME_LENGTH) return `A printer's name is at most ${MAX_PRINTER_NAME_LENGTH} characters`;
  if (CONTROL_CHARACTERS.test(name)) return "A printer's name cannot contain control characters";
  return null;
}

function newPrinterId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type PrintingSettingsResult =
  | { ok: true; enabled: boolean; printers: Printer[] }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Validate a whole Settings -> Printing save: `{ enabled, printers }`, the list
 * replacing what was there. A printer that keeps an id the organization already
 * has keeps its queue on the workstations; any other gets a new id.
 */
export function parsePrintingSettings(
  body: unknown,
  groups: readonly string[],
  existingIds: ReadonlySet<string>
): PrintingSettingsResult {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "The request body must be an object" };
  const { enabled, printers } = body as { enabled?: unknown; printers?: unknown };
  if (typeof enabled !== "boolean") return { ok: false, status: 400, error: "enabled is true or false" };
  if (!Array.isArray(printers)) return { ok: false, status: 400, error: "printers is a list" };
  if (printers.length > MAX_PRINTERS) return { ok: false, status: 400, error: `At most ${MAX_PRINTERS} printers` };
  const out: Printer[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const [index, item] of printers.entries()) {
    const where = `Printer ${index + 1}: `;
    if (!item || typeof item !== "object") return { ok: false, status: 400, error: `${where}not an object` };
    const p = item as { id?: unknown; name?: unknown; uri?: unknown; groupName?: unknown };
    const nameProblem = printerNameProblem(p.name);
    if (nameProblem) return { ok: false, status: 400, error: where + nameProblem };
    const uriProblem = printerUriProblem(p.uri);
    if (uriProblem) return { ok: false, status: 400, error: where + uriProblem };
    const name = String(p.name).trim();
    if (names.has(name.toLowerCase())) return { ok: false, status: 400, error: `${where}another printer already has the name ${name}` };
    names.add(name.toLowerCase());
    let groupName: string | null = null;
    if (p.groupName !== undefined && p.groupName !== null && p.groupName !== "") {
      if (typeof p.groupName !== "string") return { ok: false, status: 400, error: `${where}groupName is a group's name or null` };
      // Group membership is stored by exact name; a free-form one would match no workstation.
      if (!groups.includes(p.groupName)) return { ok: false, status: 404, error: `${where}workstation group not found` };
      groupName = p.groupName;
    }
    const keep = typeof p.id === "string" && PRINTER_ID_PATTERN.test(p.id) && existingIds.has(p.id) && !ids.has(p.id);
    const id = keep ? (p.id as string) : newPrinterId();
    ids.add(id);
    out.push({ id, name, uri: normalizePrinterUri(String(p.uri)), groupName });
  }
  return { ok: true, enabled, printers: out };
}

export async function listPrinters(db: D1Database, tenantId: string): Promise<Printer[]> {
  const res = await db
    .prepare("SELECT id, name, uri, group_name FROM printers WHERE tenant_id = ? ORDER BY position ASC, created_at ASC")
    .bind(tenantId)
    .all<PrinterRow>();
  return (res.results || []).map((row) => ({ id: row.id, name: row.name, uri: row.uri, groupName: row.group_name }));
}

/** Store the switch and replace the printer list, in one batch. */
export async function savePrintingSettings(db: D1Database, tenantId: string, enabled: boolean, printers: readonly Printer[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("UPDATE tenants SET printing_enabled = ?, updated_at = ? WHERE id = ?").bind(enabled ? 1 : 0, now, tenantId),
    db.prepare("DELETE FROM printers WHERE tenant_id = ?").bind(tenantId),
    ...printers.map((p, position) =>
      db
        .prepare("INSERT INTO printers (id, tenant_id, name, uri, group_name, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(p.id, tenantId, p.name, p.uri, p.groupName, position, now)
    )
  ]);
}

/** Whether a printer is limited to a group: moving a workstation in or out of one then changes what it is told. */
export async function hasGroupPrinters(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM printers p JOIN tenants t ON t.id = p.tenant_id WHERE p.tenant_id = ? AND p.group_name IS NOT NULL AND t.printing_enabled = 1 LIMIT 1")
    .bind(tenantId)
    .first<{ found: number }>();
  return Boolean(row);
}

/** What one workstation is told: nothing to print to while printing is off, else the printers meant for it. */
export function printingFor(enabled: boolean, printers: readonly Printer[], groupName: string | undefined): WorkstationPrinting {
  if (!enabled) return { enabled: false, printers: [] };
  return {
    enabled: true,
    printers: printers
      .filter((p) => p.groupName === null || p.groupName === groupName)
      .map((p) => ({ id: p.id, name: p.name, uri: p.uri }))
  };
}
