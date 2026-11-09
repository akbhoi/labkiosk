/**
 * Every customer hears about a new version of a legal document by email: the
 * Terms of Service, the Content Policy, the Privacy Policy and the Refund &
 * Cancellation Policy (src/legal.ts, ANNOUNCED_DOCUMENTS).
 *
 * The hourly run emails the owner of every active organization a version
 * concerns (`announceLegalChanges`), a batch at a time, and records each one in
 * legal_notices so nobody is emailed twice and a run that stops carries on the
 * next hour. Once every owner has been emailed, the version's notified_at is
 * set. A super admin can email a version again from System -> Legal
 * (`emailLegalNotice`).
 *
 * A version of a document organizations accept concerns every organization
 * that has not accepted it yet; a version of any other document, every
 * organization that registered before it was published (one registering later
 * read it then). The first version ever recorded of
 * a document changed nothing, so nobody is emailed about it.
 */

import { mailConfigProblem, sendMail } from "./mail";
import { activeOrganizationOwners, type OrganizationOwner } from "./notifications";
import { publishedAnnouncedVersions, type AnnouncedDocument, type PublishedVersion } from "./legal";
import type { Env } from "./types";

/** How many owners the hourly run emails at most, so it stays well inside a run's subrequests. */
export const LEGAL_NOTICES_PER_RUN = 100;
/** How many emails are sent at once. */
const EMAILS_AT_ONCE = 10;

type Published = PublishedVersion<AnnouncedDocument>;

export interface LegalNoticeOutcome {
  emailed: number;
  failed: number;
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** The message about one version, for one organization's owner. */
export function legalNoticeText(doc: Published, owner: Pick<OrganizationOwner, "name" | "ownerName">, baseDomain: string): string {
  const link = `https://${baseDomain}${doc.path}`;
  const intro = `We have updated the Lab Kiosk ${doc.title} (version ${doc.version}). You can read it at ${link}.`;
  const next = doc.required
    ? `An administrator of ${owner.name} needs to accept it in your console. From ${day(doc.effectiveAt)} the console asks for it before anything else; ` +
      "your workstations, homepage and User Portal keep working throughout."
    : `It applies to ${owner.name} from ${day(doc.publishedAt)}. Nothing is needed from you. If you have a question about it, reply to this email.`;
  return `Hello ${owner.ownerName || ""},\n\n${intro}\n\n${next}\n\nLab Kiosk`;
}

/** The organizations a version concerns, with whether each was emailed about it already. */
async function recipients(db: D1Database, doc: Published): Promise<Array<OrganizationOwner & { notified: boolean }>> {
  const [owners, accepted, notified] = await Promise.all([
    activeOrganizationOwners(db, null),
    doc.required
      ? db.prepare("SELECT DISTINCT tenant_id FROM legal_acceptances WHERE document = ? AND version = ?").bind(doc.id, doc.version).all<{ tenant_id: string }>()
      : Promise.resolve({ results: [] as Array<{ tenant_id: string }> }),
    db.prepare("SELECT tenant_id FROM legal_notices WHERE document = ? AND version = ?").bind(doc.id, doc.version).all<{ tenant_id: string }>()
  ]);
  const acceptedIds = new Set((accepted.results || []).map((r) => r.tenant_id));
  const notifiedIds = new Set((notified.results || []).map((r) => r.tenant_id));
  return owners
    // A document organizations accept concerns every one that has not; any other, those that registered before it.
    .filter((o) => (doc.required ? !acceptedIds.has(o.tenantId) : o.createdAt < doc.publishedAt))
    .map((o) => ({ ...o, notified: notifiedIds.has(o.tenantId) }));
}

/** Email one version to these owners, a few at a time, and record each outcome. */
async function send(env: Env, db: D1Database, doc: Published, owners: readonly OrganizationOwner[], baseDomain: string, now: number): Promise<LegalNoticeOutcome> {
  let emailed = 0;
  let failed = 0;
  const subject = `Updated Lab Kiosk ${doc.title}`;
  for (let i = 0; i < owners.length; i += EMAILS_AT_ONCE) {
    const batch = owners.slice(i, i + EMAILS_AT_ONCE);
    const results = await Promise.allSettled(
      batch.map((owner) =>
        sendMail(env, {
          to: owner.email,
          toName: owner.ownerName,
          subject,
          text: legalNoticeText(doc, owner, baseDomain),
          template: { name: "notice", title: `Updated ${doc.title}` }
        })
      )
    );
    const statements = results.map((result, j) => {
      const ok = result.status === "fulfilled";
      if (ok) emailed++;
      else {
        failed++;
        console.error(`[Legal] Could not email ${batch[j].name} about the ${doc.title}:`, result.reason);
      }
      return db
        .prepare(
          `INSERT INTO legal_notices (document, version, tenant_id, sent_at, outcome) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (document, version, tenant_id) DO UPDATE SET sent_at = excluded.sent_at, outcome = excluded.outcome`
        )
        .bind(doc.id, doc.version, batch[j].tenantId, now, ok ? "sent" : "failed");
    });
    if (statements.length) await db.batch(statements);
  }
  return { emailed, failed };
}

async function markNotified(db: D1Database, doc: Published, now: number): Promise<void> {
  await db.prepare("UPDATE legal_versions SET notified_at = ? WHERE document = ? AND version = ?").bind(now, doc.id, doc.version).run();
}

/** Whether an earlier version of the document was ever recorded: the first one changed nothing. */
async function hasEarlierVersion(db: D1Database, doc: Published): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM legal_versions WHERE document = ? AND version <> ? AND published_at <= ?")
    .bind(doc.id, doc.version, doc.publishedAt)
    .first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

/** Email up to `budget` organizations still waiting for a version; marks it done when nobody is left. */
async function sendWaiting(env: Env, db: D1Database, doc: Published, baseDomain: string, budget: number, now: number): Promise<LegalNoticeOutcome & { sent: number; remaining: number }> {
  const waiting = (await recipients(db, doc)).filter((o) => !o.notified);
  const batch = waiting.slice(0, Math.max(0, budget));
  const outcome = await send(env, db, doc, batch, baseDomain, now);
  if (batch.length === waiting.length) await markNotified(db, doc, now);
  return { ...outcome, sent: batch.length, remaining: waiting.length - batch.length };
}

/** Whether any organization was emailed about this version, by the hourly run or a super admin. */
async function hasNotices(db: D1Database, doc: Published): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 AS x FROM legal_notices WHERE document = ? AND version = ? LIMIT 1").bind(doc.id, doc.version).first());
}

/**
 * The hourly run: email every organization a new version concerns and has not
 * been emailed about, at most `limit` owners in all. Returns what was sent.
 */
export async function announceLegalChanges(env: Env, db: D1Database, baseDomain: string, now: number, limit = LEGAL_NOTICES_PER_RUN): Promise<LegalNoticeOutcome> {
  const total: LegalNoticeOutcome = { emailed: 0, failed: 0 };
  if (mailConfigProblem(env)) return total;
  let budget = limit;
  for (const doc of await publishedAnnouncedVersions(db, now)) {
    if (doc.notifiedAt !== null || budget <= 0) continue;
    // A first version changed nothing, unless a super admin chose to send it.
    if (!(await hasEarlierVersion(db, doc)) && !(await hasNotices(db, doc))) {
      await markNotified(db, doc, now);
      continue;
    }
    const outcome = await sendWaiting(env, db, doc, baseDomain, budget, now);
    total.emailed += outcome.emailed;
    total.failed += outcome.failed;
    budget -= outcome.sent;
  }
  return total;
}

/**
 * A super admin's "Email organizations": email the version again to every
 * organization it concerns, including those emailed before. The first
 * `limit` go now, inside the request; the hourly run sends the rest.
 */
export async function emailLegalNotice(
  env: Env,
  db: D1Database,
  doc: Published,
  baseDomain: string,
  now: number,
  limit = LEGAL_NOTICES_PER_RUN
): Promise<LegalNoticeOutcome & { remaining: number }> {
  await db.batch([
    db.prepare("DELETE FROM legal_notices WHERE document = ? AND version = ?").bind(doc.id, doc.version),
    db.prepare("UPDATE legal_versions SET notified_at = NULL WHERE document = ? AND version = ?").bind(doc.id, doc.version)
  ]);
  const { emailed, failed, remaining } = await sendWaiting(env, db, doc, baseDomain, limit, now);
  return { emailed, failed, remaining };
}
