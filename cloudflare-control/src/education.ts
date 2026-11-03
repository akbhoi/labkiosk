/**
 * The free Education plan, for institutions the platform has verified by hand.
 *
 * An institution applies from Plan in its console with its affiliation board and
 * number, its website, an official address on the website's own domain, and
 * its affiliation certificate. A six-digit code emailed to that address proves
 * the institution receives mail there; only then does the application reach the
 * platform, which reads the certificate and approves or rejects it in Super
 * Admin. Approval puts the organization on Education for PRICING.educationDays
 * with PRICING.educationWorkstations, after which it applies again.
 *
 * The certificate is kept in the AUDIT_ARCHIVE bucket under `education/`
 * (production requires the bucket already); tests and local development
 * without it use an in-process map. A rejected application's certificate is
 * deleted CERTIFICATE_RETENTION_DAYS after the decision.
 */

import { sha256Hex, timingSafeEqual } from "./auth";
import { uniformBelow } from "./conversations";
import { isLocalEnvironment } from "./database";
import { safeHttpUrl } from "./escape";
import type { Env } from "./types";

export const EDUCATION_LIMITS = {
  institution: 160,
  board: 80,
  affiliation: 60,
  website: 300,
  email: 254,
  certificateBytes: 5 * 1024 * 1024,
  certificateName: 160,
  reason: 500,
  codeMinutes: 30,
  codeAttempts: 5
} as const;

export const CERTIFICATE_RETENTION_DAYS = 90;
const DAY = 86_400;

/** Address domains anyone can sign up for, which prove nothing about an institution. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "ymail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "zohomail.in",
  "rediffmail.com",
  "yandex.com",
  "gmx.com",
  "mail.com"
]);

const CERTIFICATE_TYPES: Record<string, { magic: number[]; label: string }> = {
  "application/pdf": { magic: [0x25, 0x50, 0x44, 0x46], label: "PDF" },
  "image/jpeg": { magic: [0xff, 0xd8, 0xff], label: "JPEG" },
  "image/png": { magic: [0x89, 0x50, 0x4e, 0x47], label: "PNG" }
};

export type EducationStatus = "verifying" | "pending" | "approved" | "rejected";

export interface EducationApplication {
  id: string;
  tenant_id: string;
  institution: string;
  board: string;
  affiliation_number: string;
  website: string;
  email: string;
  code_hash: string | null;
  code_expires_at: number | null;
  code_attempts: number;
  email_verified_at: number | null;
  certificate_key: string | null;
  certificate_name: string;
  certificate_type: string;
  certificate_size: number;
  status: EducationStatus;
  decision_reason: string | null;
  created_by: string | null;
  created_at: number;
  submitted_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
}

/** What the organization's own console is shown of its application. */
export function applicationJson(a: EducationApplication) {
  return {
    id: a.id,
    institution: a.institution,
    board: a.board,
    affiliationNumber: a.affiliation_number,
    website: a.website,
    email: a.email,
    certificateName: a.certificate_name,
    status: a.status,
    reason: a.decision_reason,
    createdAt: Number(a.created_at),
    submittedAt: a.submitted_at === null ? null : Number(a.submitted_at),
    decidedAt: a.decided_at === null ? null : Number(a.decided_at)
  };
}

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Whether an address's domain is the website's, or one is a subdomain of the other. */
export function emailMatchesWebsite(email: string, website: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  let host: string;
  try {
    host = bareHost(new URL(website).hostname);
  } catch {
    return false;
  }
  if (!domain || !host || PUBLIC_MAIL_DOMAINS.has(domain) || PUBLIC_MAIL_DOMAINS.has(host)) return false;
  return domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`);
}

export interface EducationInput {
  institution: string;
  board: string;
  affiliationNumber: string;
  website: string;
  email: string;
  certificate: { name: string; type: string; bytes: Uint8Array };
}

/** The application form, from its multipart body. */
export async function parseEducationForm(form: FormData): Promise<{ ok: true; value: EducationInput } | { ok: false; error: string }> {
  const institution = line(form.get("institution"), EDUCATION_LIMITS.institution);
  if (institution.length < 3) return { ok: false, error: "Enter the institution's full name" };
  const board = line(form.get("board"), EDUCATION_LIMITS.board);
  if (board.length < 2) return { ok: false, error: "Enter the board or body it is affiliated with, such as CBSE or a state board" };
  const affiliationNumber = line(form.get("affiliationNumber"), EDUCATION_LIMITS.affiliation);
  if (affiliationNumber.length < 2) return { ok: false, error: "Enter the affiliation or recognition number" };
  const rawWebsite = line(form.get("website"), EDUCATION_LIMITS.website);
  const website = rawWebsite ? safeHttpUrl(/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`) : null;
  if (!website) return { ok: false, error: "Enter the institution's website, such as https://institute.edu.in" };
  const email = line(form.get("email"), EDUCATION_LIMITS.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter the institution's official email address" };
  if (!emailMatchesWebsite(email, website)) {
    return { ok: false, error: "The email address must be on the institution website's own domain, not a personal or free email service" };
  }
  const file = form.get("certificate");
  if (!file || typeof file === "string") return { ok: false, error: "Attach the affiliation or recognition certificate" };
  const blob = file as File;
  const type = CERTIFICATE_TYPES[blob.type];
  if (!type) return { ok: false, error: "The certificate must be a PDF, JPEG or PNG file" };
  if (blob.size === 0) return { ok: false, error: "The certificate file is empty" };
  if (blob.size > EDUCATION_LIMITS.certificateBytes) return { ok: false, error: "The certificate must be 5 MB or smaller" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!type.magic.every((b, i) => bytes[i] === b)) return { ok: false, error: `The certificate is not a real ${type.label} file` };
  const name = line(blob.name, EDUCATION_LIMITS.certificateName).replace(/[^\w.\- ()]/g, "_") || "certificate";
  return { ok: true, value: { institution, board, affiliationNumber, website, email, certificate: { name, type: blob.type, bytes } } };
}

// ----------------------------------------------------------- certificate store

const PREFIX = "education/";
const localStore = new Map<string, { bytes: Uint8Array; type: string }>();
const LOCAL_STORE_LIMIT = 100;

function bucket(env: Env): R2Bucket | null {
  if (env.AUDIT_ARCHIVE) return env.AUDIT_ARCHIVE;
  if (isLocalEnvironment(env)) return null;
  throw new Error("The AUDIT_ARCHIVE R2 bucket is not bound; certificates cannot be stored.");
}

async function storeCertificate(env: Env, key: string, bytes: Uint8Array, type: string): Promise<void> {
  const store = bucket(env);
  if (!store) {
    localStore.set(key, { bytes, type });
    if (localStore.size > LOCAL_STORE_LIMIT) localStore.delete(localStore.keys().next().value as string);
    return;
  }
  await store.put(key, bytes, { httpMetadata: { contentType: type } });
}

export async function readCertificate(env: Env, key: string): Promise<{ body: ReadableStream | Uint8Array; type: string } | null> {
  if (!key.startsWith(PREFIX)) return null;
  const store = bucket(env);
  if (!store) {
    const local = localStore.get(key);
    return local ? { body: local.bytes, type: local.type } : null;
  }
  const object = await store.get(key);
  return object ? { body: object.body, type: object.httpMetadata?.contentType || "application/octet-stream" } : null;
}

async function deleteCertificate(env: Env, key: string): Promise<void> {
  const store = bucket(env);
  if (!store) {
    localStore.delete(key);
    return;
  }
  await store.delete(key);
}

// ----------------------------------------------------------------- the flow

function sixDigits(): string {
  return String(uniformBelow(1_000_000)).padStart(6, "0");
}

async function codeHash(id: string, code: string): Promise<string> {
  return sha256Hex(`education:${id}:${code}`);
}

export async function findApplication(db: D1Database, id: string): Promise<EducationApplication | null> {
  return db.prepare("SELECT * FROM education_applications WHERE id = ?").bind(id).first<EducationApplication>();
}

/** The organization's latest application, if any. */
export async function latestApplication(db: D1Database, tenantId: string): Promise<EducationApplication | null> {
  return db
    .prepare("SELECT * FROM education_applications WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(tenantId)
    .first<EducationApplication>();
}

/**
 * Start an application: store the certificate and the details, and return the
 * code to email. An application still waiting for its code is replaced; one
 * waiting for the platform is not.
 */
export async function startApplication(
  env: Env,
  db: D1Database,
  tenantId: string,
  userId: string,
  input: EducationInput,
  nowSeconds: number
): Promise<{ ok: true; application: EducationApplication; code: string } | { ok: false; error: string; status: number }> {
  const latest = await latestApplication(db, tenantId);
  if (latest?.status === "pending") return { ok: false, error: "An application is already waiting for review", status: 409 };
  if (latest?.status === "verifying") await discardApplication(env, db, latest);
  const id = crypto.randomUUID();
  const key = `${PREFIX}${tenantId}/${id}`;
  await storeCertificate(env, key, input.certificate.bytes, input.certificate.type);
  const code = sixDigits();
  await db
    .prepare(
      `INSERT INTO education_applications (id, tenant_id, institution, board, affiliation_number, website, email, code_hash, code_expires_at,
         code_attempts, email_verified_at, certificate_key, certificate_name, certificate_type, certificate_size, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, 'verifying', ?, ?)`
    )
    .bind(
      id,
      tenantId,
      input.institution,
      input.board,
      input.affiliationNumber,
      input.website,
      input.email,
      await codeHash(id, code),
      nowSeconds + EDUCATION_LIMITS.codeMinutes * 60,
      key,
      input.certificate.name,
      input.certificate.type,
      input.certificate.bytes.byteLength,
      userId,
      nowSeconds
    )
    .run();
  return { ok: true, application: (await findApplication(db, id))!, code };
}

async function discardApplication(env: Env, db: D1Database, application: EducationApplication): Promise<void> {
  if (application.certificate_key) await deleteCertificate(env, application.certificate_key);
  await db.prepare("DELETE FROM education_applications WHERE id = ?").bind(application.id).run();
}

/** Check the emailed code; the application then waits for the platform. */
export async function confirmApplicationEmail(
  db: D1Database,
  tenantId: string,
  id: string,
  code: string,
  nowSeconds: number
): Promise<{ ok: true; application: EducationApplication } | { ok: false; error: string; status: number }> {
  const application = await findApplication(db, id);
  if (!application || application.tenant_id !== tenantId) return { ok: false, error: "Application not found", status: 404 };
  if (application.status !== "verifying" || !application.code_hash) return { ok: false, error: "This application's address is already confirmed", status: 409 };
  if (Number(application.code_attempts) >= EDUCATION_LIMITS.codeAttempts) {
    return { ok: false, error: "Too many wrong codes. Send the application again for a new code.", status: 429 };
  }
  if (!application.code_expires_at || Number(application.code_expires_at) < nowSeconds) {
    return { ok: false, error: "The code has expired. Send the application again for a new one.", status: 410 };
  }
  if (!/^\d{6}$/.test(code) || !timingSafeEqual(await codeHash(id, code), application.code_hash)) {
    await db.prepare("UPDATE education_applications SET code_attempts = code_attempts + 1 WHERE id = ?").bind(id).run();
    return { ok: false, error: "That code is not right", status: 400 };
  }
  await db
    .prepare(
      "UPDATE education_applications SET status = 'pending', code_hash = NULL, code_expires_at = NULL, email_verified_at = ?, submitted_at = ? WHERE id = ? AND status = 'verifying'"
    )
    .bind(nowSeconds, nowSeconds, id)
    .run();
  return { ok: true, application: (await findApplication(db, id))! };
}

export interface ApplicationForReview extends EducationApplication {
  tenant_name: string;
  tenant_subdomain: string;
}

/** Applications the platform has to decide first, then the decided ones, newest first. */
export async function listApplicationsForReview(db: D1Database): Promise<ApplicationForReview[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, t.name AS tenant_name, t.subdomain AS tenant_subdomain
         FROM education_applications a JOIN tenants t ON t.id = a.tenant_id
        WHERE a.status != 'verifying'
        ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(a.decided_at, a.submitted_at) DESC
        LIMIT 300`
    )
    .all<ApplicationForReview>();
  return results ?? [];
}

/** Record the platform's decision. Returns false when the application was not waiting. */
export async function decideApplication(
  db: D1Database,
  id: string,
  approve: boolean,
  reason: string | null,
  userId: string,
  nowSeconds: number
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE education_applications SET status = ?, decision_reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
    .bind(approve ? "approved" : "rejected", reason, nowSeconds, userId, id)
    .run();
  return Boolean(res.meta.changes);
}

/**
 * Hourly: drop applications whose code was never entered within a day, and the
 * certificates of rejected ones CERTIFICATE_RETENTION_DAYS after the decision.
 */
export async function purgeEducationApplications(env: Env, db: D1Database, nowSeconds: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT * FROM education_applications
        WHERE (status = 'verifying' AND created_at < ?)
           OR (status = 'rejected' AND certificate_key IS NOT NULL AND decided_at < ?)
        LIMIT 100`
    )
    .bind(nowSeconds - DAY, nowSeconds - CERTIFICATE_RETENTION_DAYS * DAY)
    .all<EducationApplication>();
  for (const a of results ?? []) {
    if (a.status === "verifying") {
      await discardApplication(env, db, a);
    } else {
      if (a.certificate_key) await deleteCertificate(env, a.certificate_key);
      await db.prepare("UPDATE education_applications SET certificate_key = NULL WHERE id = ?").bind(a.id).run();
    }
  }
  return (results ?? []).length;
}
