/**
 * Versioned legal documents and the record of who accepted them.
 *
 * Each document an organization accepts has a version here. Changing a
 * document's text means a new version: the first time the Worker serves it,
 * legal_versions records when, every organization that has not accepted it is
 * asked to in its console, and once LEGAL_NOTICE_DAYS have passed its console
 * asks before anything else, until an administrator of the organization (its
 * owner or an `org_admin`) accepts. Workstations, the organization homepage and
 * the User Portal keep working throughout.
 *
 * legal_acceptances is append-only and has no foreign keys: it is the evidence
 * of what was agreed, and outlives the organization and the user.
 */

/** A document an organization accepts. */
export type LegalDocumentId = "terms" | "content" | "privacy";

export interface LegalDocument {
  id: LegalDocumentId;
  title: string;
  path: string;
  /** The version the page shows now. A new text is a new version. */
  version: string;
  /** Accepted (the console asks for it), or only acknowledged at registration. */
  required: boolean;
}

/**
 * The documents in force. The versions are the dates the pages give as
 * "Last updated"; keep them in step with src/ui_legal.ts.
 *
 * The Data Processing Agreement (/dpa) is part of the Terms, not a document of
 * its own: accepting the Terms accepts it, so a change to its text is a new
 * "terms" version, and /dpa shows that version.
 */
export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  { id: "terms", title: "Terms of Service", path: "/terms", version: "2026-10-20", required: true },
  { id: "content", title: "Content Policy", path: "/content-policy", version: "2026-10-13", required: true },
  { id: "privacy", title: "Privacy Policy", path: "/privacy", version: "2026-10-20", required: false }
];

/** Days between a version's first publication and the console asking before anything else. */
export const LEGAL_NOTICE_DAYS = 30;
const DAY = 86_400;

export function isLegalDocumentId(value: unknown): value is LegalDocumentId {
  return LEGAL_DOCUMENTS.some((d) => d.id === value);
}

export interface PublishedVersion extends LegalDocument {
  /** Unix seconds: when the Worker first served this version. */
  publishedAt: number;
  /** Unix seconds: from when an organization that has not accepted it is asked before anything else. */
  effectiveAt: number;
  notifiedAt: number | null;
}

/**
 * The documents in force with when each version was first published, recording
 * a version the first time it is seen.
 */
export async function publishedLegalVersions(db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<PublishedVersion[]> {
  const rows = (
    await db
      .prepare("SELECT document, version, published_at, notified_at FROM legal_versions")
      .all<{ document: string; version: string; published_at: number; notified_at: number | null }>()
  ).results || [];
  const result: PublishedVersion[] = [];
  for (const doc of LEGAL_DOCUMENTS) {
    let row = rows.find((r) => r.document === doc.id && r.version === doc.version);
    if (!row) {
      await db
        .prepare("INSERT OR IGNORE INTO legal_versions (document, version, published_at) VALUES (?, ?, ?)")
        .bind(doc.id, doc.version, now)
        .run();
      row =
        (await db
          .prepare("SELECT document, version, published_at, notified_at FROM legal_versions WHERE document = ? AND version = ?")
          .bind(doc.id, doc.version)
          .first<{ document: string; version: string; published_at: number; notified_at: number | null }>()) ?? undefined;
      if (!row) throw new Error(`Could not record ${doc.id} version ${doc.version}`);
    }
    const publishedAt = Number(row.published_at);
    result.push({ ...doc, publishedAt, effectiveAt: publishedAt + LEGAL_NOTICE_DAYS * DAY, notifiedAt: row.notified_at ?? null });
  }
  return result;
}

/** The versions of the required documents an organization has accepted, by document. */
async function acceptedVersions(db: D1Database, tenantId: string): Promise<Map<string, Set<string>>> {
  const rows = (
    await db
      .prepare("SELECT DISTINCT document, version FROM legal_acceptances WHERE tenant_id = ?")
      .bind(tenantId)
      .all<{ document: string; version: string }>()
  ).results || [];
  const accepted = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = accepted.get(row.document) ?? new Set<string>();
    set.add(row.version);
    accepted.set(row.document, set);
  }
  return accepted;
}

export interface LegalStatus {
  /** Required documents whose current version the organization has not accepted. */
  pending: Array<Pick<PublishedVersion, "id" | "title" | "path" | "version" | "effectiveAt">>;
  /** A pending document's notice period has passed: the console asks before anything else. */
  gated: boolean;
}

/** Where an organization stands with the documents in force. */
export async function organizationLegalStatus(db: D1Database, tenantId: string, now = Math.floor(Date.now() / 1000)): Promise<LegalStatus> {
  const [published, accepted] = await Promise.all([publishedLegalVersions(db, now), acceptedVersions(db, tenantId)]);
  const pending = published
    .filter((doc) => doc.required && !accepted.get(doc.id)?.has(doc.version))
    .map(({ id, title, path, version, effectiveAt }) => ({ id, title, path, version, effectiveAt }));
  return { pending, gated: pending.some((doc) => doc.effectiveAt <= now) };
}

export interface AcceptanceInput {
  tenantId: string;
  tenantName: string;
  userId: string;
  userEmail: string;
  documents: ReadonlyArray<{ id: LegalDocumentId; version: string }>;
  source: "registration" | "console";
  ip: string | null;
  userAgent: string | null;
  now?: number;
}

/** Append one acceptance per document. Never updated or deleted. */
export async function recordLegalAcceptances(db: D1Database, input: AcceptanceInput): Promise<void> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const statements = input.documents.map((doc) =>
    db
      .prepare(
        `INSERT INTO legal_acceptances (id, tenant_id, tenant_name, user_id, user_email, document, version, source, accepted_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        input.tenantId,
        input.tenantName.slice(0, 200),
        input.userId,
        input.userEmail.slice(0, 320),
        doc.id,
        doc.version,
        input.source,
        now,
        input.ip ? input.ip.slice(0, 64) : null,
        input.userAgent ? input.userAgent.slice(0, 400) : null
      )
  );
  if (statements.length) await db.batch(statements);
}

export interface AcceptanceRow {
  tenant_id: string;
  tenant_name: string;
  user_id: string;
  user_email: string;
  document: string;
  version: string;
  source: string;
  accepted_at: number;
  ip: string | null;
  user_agent: string | null;
}

/** One organization's acceptances, or every organization's (null), oldest first. */
export async function listLegalAcceptances(db: D1Database, tenantId: string | null): Promise<AcceptanceRow[]> {
  const columns = "tenant_id, tenant_name, user_id, user_email, document, version, source, accepted_at, ip, user_agent";
  const res = tenantId
    ? await db.prepare(`SELECT ${columns} FROM legal_acceptances WHERE tenant_id = ? ORDER BY accepted_at, id`).bind(tenantId).all<AcceptanceRow>()
    : await db.prepare(`SELECT ${columns} FROM legal_acceptances ORDER BY accepted_at, id`).all<AcceptanceRow>();
  return res.results || [];
}

/** Acceptances as CSV, each field quoted, and any field a spreadsheet would run as a formula prefixed with '. */
export function acceptancesCsv(rows: readonly AcceptanceRow[]): string {
  const header = ["organization_id", "organization", "user_id", "email", "document", "version", "source", "accepted_at_utc", "ip", "user_agent"];
  const field = (value: unknown) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [header.map(field).join(",")];
  for (const r of rows) {
    lines.push(
      [r.tenant_id, r.tenant_name, r.user_id, r.user_email, r.document, r.version, r.source, new Date(r.accepted_at * 1000).toISOString(), r.ip, r.user_agent]
        .map(field)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** How many active organizations accepted each current version, for the platform's view. */
export async function legalAcceptanceCounts(db: D1Database): Promise<Map<string, number>> {
  const rows = (
    await db
      .prepare(
        `SELECT a.document, a.version, COUNT(DISTINCT a.tenant_id) AS n FROM legal_acceptances a
         JOIN tenants t ON t.id = a.tenant_id AND t.status = 'active' GROUP BY a.document, a.version`
      )
      .all<{ document: string; version: string; n: number }>()
  ).results || [];
  return new Map(rows.map((r) => [`${r.document}@${r.version}`, Number(r.n) || 0]));
}
