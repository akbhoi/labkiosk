/**
 * Certified hardware and the reseller directory on /hardware.
 *
 * Certified: the platform's administrator marks a computer model certified
 * once it has passed the checks a workstation already reports (it boots, plays
 * video with hardware decoding, reaches the network). Certification is kept
 * apart from hardware_models, which the hourly job rebuilds from scratch, and
 * is keyed by maker and model without regard to case, as that table groups them.
 *
 * Resellers: a company applies with the contact form (reason "Become a
 * reseller"), which files the application in Mail like any message and keeps
 * its listing details here. The administrator approves or rejects it from
 * Super Admin -> System -> Hardware. The public directory on /hardware appears
 * only once at least one reseller is approved. No payments or commission.
 */

import { safeHttpUrl } from "./escape";

export const RESELLER_LIMITS = {
  company: 160,
  phone: 40,
  place: 80,
  website: 300,
  stocks: 500,
  note: 300
} as const;

const PHONE_PATTERN = /^\+?[0-9 ()-]{6,40}$/;

export interface CertifiedModel {
  vendor: string;
  model: string;
  note: string | null;
  certifiedAt: number;
}

export type ResellerStatus = "pending" | "approved" | "rejected";

export interface Reseller {
  id: string;
  company: string;
  contact_name: string;
  email: string;
  phone: string;
  state: string;
  city: string;
  website: string | null;
  stocks: string | null;
  status: ResellerStatus;
  conversation_id: string | null;
  created_at: number;
  decided_at: number | null;
}

/** What the public directory shows of an approved reseller: no contact person's name. */
export interface PublicReseller {
  company: string;
  email: string;
  phone: string;
  state: string;
  city: string;
  website: string | null;
  stocks: string | null;
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export async function listCertifiedModels(db: D1Database): Promise<CertifiedModel[]> {
  const { results } = await db
    .prepare("SELECT vendor, model, note, certified_at FROM certified_hardware ORDER BY vendor COLLATE NOCASE, model COLLATE NOCASE")
    .all<{ vendor: string; model: string; note: string | null; certified_at: number }>();
  return (results ?? []).map((r) => ({ vendor: r.vendor, model: r.model, note: r.note, certifiedAt: Number(r.certified_at) }));
}

/** Whether a model is certified, matched as hardware_models groups them. */
export function certifiedLookup(certified: readonly CertifiedModel[]): (vendor: string, model: string) => CertifiedModel | undefined {
  const byKey = new Map(certified.map((c) => [`${key(c.vendor)}\u0000${key(c.model)}`, c]));
  return (vendor, model) => byKey.get(`${key(vendor)}\u0000${key(model)}`);
}

/** Certify a model, or update its note. Returns the problem, or null. */
export async function certifyModel(
  db: D1Database,
  input: { vendor?: unknown; model?: unknown; note?: unknown },
  userId: string,
  nowSeconds: number
): Promise<string | null> {
  const vendor = line(input.vendor, 120);
  const model = line(input.model, 160);
  const note = line(input.note, RESELLER_LIMITS.note) || null;
  if (!vendor || !model) return "Name the maker and the model";
  await db
    .prepare(
      "INSERT INTO certified_hardware (vendor_key, model_key, vendor, model, note, certified_at, certified_by) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(vendor_key, model_key) DO UPDATE SET vendor = excluded.vendor, model = excluded.model, note = excluded.note"
    )
    .bind(key(vendor), key(model), vendor, model, note, nowSeconds, userId)
    .run();
  return null;
}

export async function uncertifyModel(db: D1Database, input: { vendor?: unknown; model?: unknown }): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM certified_hardware WHERE vendor_key = ? AND model_key = ?")
    .bind(key(line(input.vendor, 120)), key(line(input.model, 160)))
    .run();
  return Boolean(res.meta.changes);
}

export interface ResellerApplication {
  company: string;
  phone: string;
  state: string;
  city: string;
  website: string | null;
  stocks: string | null;
}

/** The listing details a reseller application carries beyond the contact form's own fields. */
export function parseResellerApplication(
  organization: string,
  body: { phone?: unknown; state?: unknown; city?: unknown; website?: unknown; stocks?: unknown }
): { ok: true; value: ResellerApplication } | { ok: false; error: string } {
  const company = line(organization, RESELLER_LIMITS.company);
  if (company.length < 2) return { ok: false, error: "Enter your company's name under Organization" };
  const phone = line(body.phone, RESELLER_LIMITS.phone);
  if (!PHONE_PATTERN.test(phone)) return { ok: false, error: "Enter a phone number customers can call, such as +91 98765 43210" };
  const state = line(body.state, RESELLER_LIMITS.place);
  const city = line(body.city, RESELLER_LIMITS.place);
  if (!state || !city) return { ok: false, error: "Enter the state and the city you sell in" };
  const rawWebsite = line(body.website, RESELLER_LIMITS.website);
  const website = rawWebsite ? safeHttpUrl(/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`) : null;
  if (rawWebsite && !website) return { ok: false, error: "The website must be an address such as https://example.com" };
  const stocks = line(body.stocks, RESELLER_LIMITS.stocks) || null;
  return { ok: true, value: { company, phone, state, city, website, stocks } };
}

/** A reseller already listed or waiting under this address. */
export async function openResellerFor(db: D1Database, email: string): Promise<Reseller | null> {
  return db
    .prepare("SELECT * FROM resellers WHERE email = ? AND status IN ('pending', 'approved') LIMIT 1")
    .bind(email.toLowerCase())
    .first<Reseller>();
}

export async function createReseller(
  db: D1Database,
  application: ResellerApplication,
  contact: { name: string; email: string },
  conversationId: string,
  nowSeconds: number
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO resellers (id, company, contact_name, email, phone, state, city, website, stocks, status, conversation_id, created_at, decided_at, decided_by) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)"
    )
    .bind(
      id,
      application.company,
      contact.name,
      contact.email.toLowerCase(),
      application.phone,
      application.state,
      application.city,
      application.website,
      application.stocks,
      conversationId,
      nowSeconds
    )
    .run();
  return id;
}

export async function listResellers(db: D1Database): Promise<Reseller[]> {
  const { results } = await db
    .prepare("SELECT * FROM resellers ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC LIMIT 500")
    .all<Reseller>();
  return results ?? [];
}

export async function findReseller(db: D1Database, id: string): Promise<Reseller | null> {
  return db.prepare("SELECT * FROM resellers WHERE id = ?").bind(id).first<Reseller>();
}

/** Approve or reject an application, or take an approved reseller off the directory (rejected). */
export async function decideReseller(
  db: D1Database,
  id: string,
  status: "approved" | "rejected",
  userId: string,
  nowSeconds: number
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE resellers SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status != ?")
    .bind(status, nowSeconds, userId, id, status)
    .run();
  return Boolean(res.meta.changes);
}

/** The public directory: approved resellers by state, then city, then name. */
export async function listPublicResellers(db: D1Database): Promise<PublicReseller[]> {
  const { results } = await db
    .prepare(
      "SELECT company, email, phone, state, city, website, stocks FROM resellers WHERE status = 'approved' " +
        "ORDER BY state COLLATE NOCASE, city COLLATE NOCASE, company COLLATE NOCASE"
    )
    .all<PublicReseller>();
  return results ?? [];
}
