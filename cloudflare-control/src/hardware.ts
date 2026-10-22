/**
 * The machine each workstation runs on, and the hardware compatibility list
 * built from every organization's reports.
 *
 * A workstation's agent reads its firmware's identity (DMI), CPU, memory,
 * boot mode, attached keyboard and touchscreen, and its wired adapters' MAC
 * addresses once per start (report_hardware in agent.py) and sends them with
 * POST /api/devices/hardware. The latest report replaces the last on its
 * client_devices row; the console shows it on the workstation's card, and
 * Wake-on-LAN reads the MAC addresses from it.
 *
 * The hourly cron folds every report into hardware_models: one row per
 * manufacturer and model, with how many organizations and workstations run
 * it and nothing that names either. The platform's administrators see every
 * model; the public list at /hardware shows the models at least
 * PUBLIC_MODEL_MIN_ORGANIZATIONS organizations run, so no model there points
 * at one organization.
 */

import { DEMO_SLUGS } from "./demo";

export const BOOT_MODES = ["uefi", "bios"] as const;
export type BootMode = (typeof BOOT_MODES)[number];

/** The agent sends at most this many wired adapters (MAX_WIRED_MACS in agent.py). */
export const MAX_MACS_PER_REPORT = 8;
/** A model shows on the public list once this many organizations run it. */
export const PUBLIC_MODEL_MIN_ORGANIZATIONS = 3;
const MAX_VENDOR = 80;
const MAX_MODEL = 80;
const MAX_CPU = 120;
const MAC_PATTERN = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;

/**
 * What firmware says when the manufacturer filled nothing in. Such a value
 * names no model, and grouping machines by it would lump unrelated ones
 * together, so it is read as unknown.
 */
const PLACEHOLDER_NAMES = new Set([
  "to be filled by o.e.m.",
  "to be filled by oem",
  "system product name",
  "system manufacturer",
  "system version",
  "default string",
  "not applicable",
  "not specified",
  "none",
  "oem",
  "o.e.m.",
  "unknown",
  "invalid",
  "type1productconfigid",
  "123456789",
  "x.x"
]);

export interface Hardware {
  /** The manufacturer, as firmware names it; "" when it names none. */
  vendor: string;
  /** The model, as firmware names it; "" when it names none. */
  model: string;
  cpu: string;
  cores: number;
  memoryMb: number;
  bootMode: BootMode;
  /** Whether a keyboard / touchscreen is attached; null when the agent could not tell. */
  keyboard: boolean | null;
  touch: boolean | null;
  /** Its wired network adapters, for Wake-on-LAN. */
  macs: string[];
}

function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

/** A firmware name, or "" when it is one of the placeholders firmware ships with. */
export function firmwareName(value: unknown, field: string, max: number): string {
  const name = text(value, field, max);
  return PLACEHOLDER_NAMES.has(name.toLowerCase()) ? "" : name;
}

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function presence(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${field} must be true, false or null`);
  return value;
}

/** A unicast, globally meaningful MAC address: what a Wake-on-LAN packet can be addressed to. */
function wakeableMac(mac: string): boolean {
  if (mac === "00:00:00:00:00:00" || mac === "ff:ff:ff:ff:ff:ff") return false;
  return (parseInt(mac.slice(0, 2), 16) & 1) === 0;
}

/** Validate a hardware report from a workstation; throws with the reason on anything malformed. */
export function parseHardwareReport(input: unknown): Hardware {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The hardware report must be a JSON object");
  }
  const report = input as Record<string, unknown>;
  if (typeof report.bootMode !== "string" || !(BOOT_MODES as readonly string[]).includes(report.bootMode)) {
    throw new Error("bootMode is uefi or bios");
  }
  const rawMacs = report.macs ?? [];
  if (!Array.isArray(rawMacs) || rawMacs.length > MAX_MACS_PER_REPORT) {
    throw new Error(`macs must list at most ${MAX_MACS_PER_REPORT} addresses`);
  }
  const macs: string[] = [];
  for (const [index, value] of rawMacs.entries()) {
    const mac = typeof value === "string" ? value.toLowerCase() : "";
    if (!MAC_PATTERN.test(mac)) throw new Error(`macs[${index}] is not a MAC address`);
    if (wakeableMac(mac) && !macs.includes(mac)) macs.push(mac);
  }
  return {
    vendor: firmwareName(report.vendor, "vendor", MAX_VENDOR),
    model: firmwareName(report.model, "model", MAX_MODEL),
    cpu: text(report.cpu, "cpu", MAX_CPU),
    cores: whole(report.cores, "cores", 1, 1024),
    memoryMb: whole(report.memoryMb, "memoryMb", 64, 16 * 1024 * 1024),
    bootMode: report.bootMode as BootMode,
    keyboard: presence(report.keyboard, "keyboard"),
    touch: presence(report.touch, "touch"),
    macs
  };
}

/** Keep a workstation's latest report on its row. False when the row does not exist yet. */
export async function recordHardware(
  db: D1Database,
  tenantId: string,
  clientId: string,
  report: Hardware,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE client_devices SET hardware = ?, hardware_at = ? WHERE tenant_id = ? AND client_id = ?")
    .bind(JSON.stringify(report), now, tenantId, clientId)
    .run();
  return result.meta.changes > 0;
}

/**
 * A stored report, read back for /api/clients. One that no longer parses (a
 * later release narrowed the format) is dropped with a warning rather than shown.
 */
export function storedHardware(json: string | null | undefined, at: number | null | undefined): (Hardware & { reportedAt: number }) | undefined {
  if (!json) return undefined;
  try {
    return { ...parseHardwareReport(JSON.parse(json)), reportedAt: (at ?? 0) * 1000 };
  } catch (err) {
    console.warn("[Worker] A stored hardware report no longer reads:", err);
    return undefined;
  }
}

export interface HardwareModel {
  vendor: string;
  model: string;
  organizations: number;
  workstations: number;
  /** How many of those workstations start in UEFI mode; the rest start in BIOS mode. */
  uefi: number;
  /** How many have a touchscreen attached. */
  touch: number;
  /** The least memory any of them runs with, MB. */
  minMemoryMb: number | null;
}

interface HardwareModelRow {
  vendor: string;
  model: string;
  organizations: number;
  workstations: number;
  uefi: number;
  touch: number;
  min_memory_mb: number | null;
}

function modelOf(row: HardwareModelRow): HardwareModel {
  return {
    vendor: row.vendor,
    model: row.model,
    organizations: Number(row.organizations),
    workstations: Number(row.workstations),
    uefi: Number(row.uefi),
    touch: Number(row.touch),
    minMemoryMb: row.min_memory_mb === null ? null : Number(row.min_memory_mb)
  };
}

/**
 * Rebuild hardware_models from every workstation's last report, leaving out
 * the platform's demos and machines whose firmware names no model. Machines
 * are grouped without regard to case ("LENOVO" and "Lenovo" are one maker);
 * the spelling most of them report is the one shown.
 */
export async function rebuildHardwareModels(db: D1Database, now: number): Promise<number> {
  const demoMarks = DEMO_SLUGS.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT d.tenant_id AS tenant_id, d.hardware AS hardware
       FROM client_devices d JOIN tenants t ON t.id = d.tenant_id
       WHERE d.hardware IS NOT NULL AND t.subdomain NOT IN (${demoMarks})`
    )
    .bind(...DEMO_SLUGS)
    .all<{ tenant_id: string; hardware: string }>();

  interface Tally {
    spellings: Map<string, number>;
    tenants: Set<string>;
    workstations: number;
    uefi: number;
    touch: number;
    minMemoryMb: number | null;
  }
  const tallies = new Map<string, Tally>();
  for (const row of results ?? []) {
    let hardware: Hardware;
    try {
      hardware = parseHardwareReport(JSON.parse(row.hardware));
    } catch (err) {
      console.warn("[Worker] Leaving a hardware report that no longer reads out of the model list:", err);
      continue;
    }
    if (!hardware.vendor || !hardware.model) continue;
    const key = `${hardware.vendor.toLowerCase()}\u0000${hardware.model.toLowerCase()}`;
    const tally = tallies.get(key) ?? { spellings: new Map(), tenants: new Set(), workstations: 0, uefi: 0, touch: 0, minMemoryMb: null };
    const spelling = `${hardware.vendor}\u0000${hardware.model}`;
    tally.spellings.set(spelling, (tally.spellings.get(spelling) ?? 0) + 1);
    tally.tenants.add(row.tenant_id);
    tally.workstations += 1;
    if (hardware.bootMode === "uefi") tally.uefi += 1;
    if (hardware.touch) tally.touch += 1;
    tally.minMemoryMb = tally.minMemoryMb === null ? hardware.memoryMb : Math.min(tally.minMemoryMb, hardware.memoryMb);
    tallies.set(key, tally);
  }

  const statements = [db.prepare("DELETE FROM hardware_models")];
  for (const tally of tallies.values()) {
    const [spelling] = [...tally.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const [vendor, model] = spelling.split("\u0000");
    statements.push(
      db
        .prepare(
          `INSERT INTO hardware_models (vendor, model, organizations, workstations, uefi, touch, min_memory_mb, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(vendor, model, tally.tenants.size, tally.workstations, tally.uefi, tally.touch, tally.minMemoryMb, now)
    );
  }
  await db.batch(statements);
  return tallies.size;
}

/** Every model, most workstations first: what the platform's administrators see. */
export async function listHardwareModels(db: D1Database, limit = 500): Promise<HardwareModel[]> {
  const { results } = await db
    .prepare(
      `SELECT vendor, model, organizations, workstations, uefi, touch, min_memory_mb
       FROM hardware_models ORDER BY workstations DESC, vendor, model LIMIT ?`
    )
    .bind(limit)
    .all<HardwareModelRow>();
  return (results ?? []).map(modelOf);
}

/** The models enough organizations run to list publicly, by maker and model. */
export async function listPublicHardwareModels(db: D1Database): Promise<HardwareModel[]> {
  const { results } = await db
    .prepare(
      `SELECT vendor, model, organizations, workstations, uefi, touch, min_memory_mb
       FROM hardware_models WHERE organizations >= ? ORDER BY vendor COLLATE NOCASE, model COLLATE NOCASE`
    )
    .bind(PUBLIC_MODEL_MIN_ORGANIZATIONS)
    .all<HardwareModelRow>();
  return (results ?? []).map(modelOf);
}

/** When hardware_models was last rebuilt (seconds), or null before the first time. */
export async function hardwareModelsComputedAt(db: D1Database): Promise<number | null> {
  const row = await db.prepare("SELECT MAX(computed_at) AS at FROM hardware_models").first<{ at: number | null }>();
  return row?.at ?? null;
}
