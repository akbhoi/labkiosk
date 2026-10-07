/**
 * The Super Admin's Tasks and Support inbox (migration 0020).
 *
 * A conversation is one request with its whole history: a signup waiting for
 * approval, an organization asking for Remote Control, or a support message
 * that arrived by email or through the contact form. Every message sent from
 * the console and every reply that comes back is a row in
 * `conversation_messages`, so the platform owner never needs a mail client.
 *
 * Also here: the organization profile captured at signup, and the one-time
 * email codes that verify an address before an account exists.
 */

import { sha256Hex } from "./auth";

export type ConversationKind = "signup" | "remote_control" | "support";
export type ConversationStatus = "open" | "approved" | "rejected" | "closed";
export type MessageDirection = "inbound" | "outbound" | "note" | "event";

/** The kinds the Tasks tab shows; Support shows the rest. */
export const TASK_KINDS: readonly ConversationKind[] = ["signup", "remote_control"];

export interface Conversation {
  id: string;
  kind: ConversationKind;
  tenant_id: string | null;
  reference: string;
  subject: string;
  contact_email: string;
  contact_name: string | null;
  status: ConversationStatus;
  unread: number;
  created_at: number;
  updated_at: number;
  last_message_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body: string;
  email_message_id: string | null;
  author_user_id: string | null;
  delivery: "sent" | "failed" | null;
  created_at: number;
}

export interface OrganizationProfile {
  tenant_id: string;
  legal_name: string | null;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  email_verified_at: number | null;
  phone_verified_at: number | null;
  phone_verified_by: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  region: string | null;
  postal_code: string;
  country: string;
  tax_id: string | null;
  billing_email: string | null;
  workstation_estimate: number | null;
  organization_type: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

/** Longest message body stored or sent, in characters. */
export const MAX_MESSAGE_CHARS = 20_000;

const now = () => Math.floor(Date.now() / 1000);

/** Unambiguous characters for references people read aloud and type. */
const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** A short reference such as LK-7Q2M9X, carried in every email subject. */
export function newReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "LK-" + Array.from(bytes, (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join("");
}

/** The reference a subject carries, e.g. "Re: [LK-7Q2M9X] Your registration". */
export function referenceInSubject(subject: string): string | null {
  const match = subject.match(/\[(LK-[A-Z0-9]{6})\]/i);
  return match ? match[1].toUpperCase() : null;
}

/** "[LK-7Q2M9X] subject", without stacking a second reference. */
export function subjectWithReference(reference: string, subject: string): string {
  const clean = subject.replace(/\[LK-[A-Z0-9]{6}\]\s*/gi, "").trim();
  return `[${reference}] ${clean}`;
}

export async function createConversation(
  db: D1Database,
  data: { kind: ConversationKind; tenantId: string | null; subject: string; contactEmail: string; contactName?: string | null }
): Promise<Conversation> {
  const ts = now();
  // A collision on the unique reference is astronomically unlikely, and it
  // fails loudly rather than threading two requests together.
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    kind: data.kind,
    tenant_id: data.tenantId,
    reference: newReference(),
    subject: data.subject.slice(0, 300),
    contact_email: data.contactEmail.toLowerCase(),
    contact_name: data.contactName ? data.contactName.slice(0, 120) : null,
    status: "open",
    unread: 1,
    created_at: ts,
    updated_at: ts,
    last_message_at: ts,
    resolved_at: null,
    resolved_by: null
  };
  await db
    .prepare(
      `INSERT INTO conversations (id, kind, tenant_id, reference, subject, contact_email, contact_name, status, unread, created_at, updated_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)`
    )
    .bind(
      conversation.id,
      conversation.kind,
      conversation.tenant_id,
      conversation.reference,
      conversation.subject,
      conversation.contact_email,
      conversation.contact_name,
      ts,
      ts,
      ts
    )
    .run();
  return conversation;
}

export async function addConversationMessage(
  db: D1Database,
  data: {
    conversationId: string;
    direction: MessageDirection;
    body: string;
    fromAddress?: string | null;
    toAddress?: string | null;
    subject?: string | null;
    emailMessageId?: string | null;
    authorUserId?: string | null;
    delivery?: "sent" | "failed" | null;
  }
): Promise<ConversationMessage> {
  const ts = now();
  const message: ConversationMessage = {
    id: crypto.randomUUID(),
    conversation_id: data.conversationId,
    direction: data.direction,
    from_address: data.fromAddress ?? null,
    to_address: data.toAddress ?? null,
    subject: data.subject ?? null,
    body: data.body.slice(0, MAX_MESSAGE_CHARS),
    email_message_id: data.emailMessageId ?? null,
    author_user_id: data.authorUserId ?? null,
    delivery: data.delivery ?? null,
    created_at: ts
  };
  // An inbound message is what the platform owner has not read yet.
  const unread = data.direction === "inbound" ? 1 : null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO conversation_messages (id, conversation_id, direction, from_address, to_address, subject, body, email_message_id, author_user_id, delivery, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        message.id,
        message.conversation_id,
        message.direction,
        message.from_address,
        message.to_address,
        message.subject,
        message.body,
        message.email_message_id,
        message.author_user_id,
        message.delivery,
        ts
      ),
    db
      .prepare(
        `UPDATE conversations SET last_message_at = ?, updated_at = ?, unread = COALESCE(?, unread) WHERE id = ?`
      )
      .bind(ts, ts, unread, data.conversationId)
  ]);
  return message;
}

export async function findConversation(db: D1Database, id: string): Promise<Conversation | null> {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").bind(id).first<Conversation>();
}

export async function findConversationByReference(db: D1Database, reference: string): Promise<Conversation | null> {
  return db.prepare("SELECT * FROM conversations WHERE reference = ?").bind(reference.toUpperCase()).first<Conversation>();
}

/** The conversation one of these Message-IDs belongs to, newest first. */
export async function findConversationByEmailMessageIds(db: D1Database, ids: string[]): Promise<Conversation | null> {
  // Stored provider ids may or may not carry the angle brackets of a Message-ID.
  const forms = ids.filter(Boolean).flatMap((id) => [id, id.replace(/^<(.*)>$/, "$1")]);
  const unique = Array.from(new Set(forms)).slice(-90);
  if (!unique.length) return null;
  const marks = unique.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT c.* FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.email_message_id IN (${marks}) ORDER BY m.created_at DESC LIMIT 1`
    )
    .bind(...unique)
    .first<Conversation>();
}

/** An open request of this kind for an organization, if there is one. */
export async function findOpenConversationForTenant(
  db: D1Database,
  tenantId: string,
  kind: ConversationKind
): Promise<Conversation | null> {
  return db
    .prepare("SELECT * FROM conversations WHERE tenant_id = ? AND kind = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .bind(tenantId, kind)
    .first<Conversation>();
}

export interface ConversationListRow extends Conversation {
  message_count: number;
  organization_name: string | null;
  organization_subdomain: string | null;
}

/**
 * One box of the inbox. Open items come first, oldest first -- the order they
 * should be worked in -- then everything else, most recent first.
 */
export async function listConversations(
  db: D1Database,
  kinds: readonly ConversationKind[],
  filter: "open" | "closed" | "all",
  limit = 200
): Promise<ConversationListRow[]> {
  const marks = kinds.map(() => "?").join(", ");
  const statusClause = filter === "open" ? "AND c.status = 'open'" : filter === "closed" ? "AND c.status <> 'open'" : "";
  const result = await db
    .prepare(
      `SELECT c.*, t.name AS organization_name, t.subdomain AS organization_subdomain,
              (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c LEFT JOIN tenants t ON t.id = c.tenant_id
       WHERE c.kind IN (${marks}) ${statusClause}
       ORDER BY CASE WHEN c.status = 'open' THEN 0 ELSE 1 END,
                CASE WHEN c.status = 'open' THEN c.created_at ELSE -c.last_message_at END
       LIMIT ?`
    )
    .bind(...kinds, Math.max(1, Math.min(500, limit)))
    .all<ConversationListRow>();
  return result.results || [];
}

/** Open items per box, and unread support conversations, for the console's badges. */
export async function inboxCounts(db: D1Database): Promise<{ openTasks: number; openSupport: number; unreadSupport: number }> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN kind IN ('signup', 'remote_control') AND status = 'open' THEN 1 ELSE 0 END) AS open_tasks,
         SUM(CASE WHEN kind = 'support' AND status = 'open' THEN 1 ELSE 0 END) AS open_support,
         SUM(CASE WHEN kind = 'support' AND unread = 1 THEN 1 ELSE 0 END) AS unread_support
       FROM conversations`
    )
    .first<{ open_tasks: number | null; open_support: number | null; unread_support: number | null }>();
  return {
    openTasks: Number(row?.open_tasks || 0),
    openSupport: Number(row?.open_support || 0),
    unreadSupport: Number(row?.unread_support || 0)
  };
}

export async function listConversationMessages(db: D1Database, conversationId: string): Promise<ConversationMessage[]> {
  const result = await db
    .prepare("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC")
    .bind(conversationId)
    .all<ConversationMessage>();
  return result.results || [];
}

export async function markConversationRead(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE conversations SET unread = 0 WHERE id = ?").bind(id).run();
}

export async function setConversationStatus(
  db: D1Database,
  id: string,
  status: ConversationStatus,
  userId: string | null
): Promise<void> {
  const ts = now();
  const resolved = status === "open" ? null : ts;
  await db
    .prepare("UPDATE conversations SET status = ?, updated_at = ?, resolved_at = ?, resolved_by = ? WHERE id = ?")
    .bind(status, ts, resolved, status === "open" ? null : userId, id)
    .run();
}

// ------------------------------------------------------------ organization profile

export type ProfileInput = Omit<
  OrganizationProfile,
  "tenant_id" | "phone_verified_at" | "phone_verified_by" | "created_at" | "updated_at"
>;

export async function createOrganizationProfile(db: D1Database, tenantId: string, profile: ProfileInput): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT INTO organization_profiles (tenant_id, legal_name, contact_name, contact_email, contact_phone, email_verified_at,
         address_line1, address_line2, city, region, postal_code, country, tax_id, billing_email, workstation_estimate,
         organization_type, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      tenantId,
      profile.legal_name,
      profile.contact_name,
      profile.contact_email.toLowerCase(),
      profile.contact_phone,
      profile.email_verified_at,
      profile.address_line1,
      profile.address_line2,
      profile.city,
      profile.region,
      profile.postal_code,
      profile.country,
      profile.tax_id,
      profile.billing_email,
      profile.workstation_estimate,
      profile.organization_type,
      profile.notes,
      ts,
      ts
    )
    .run();
}

export async function findOrganizationProfile(db: D1Database, tenantId: string): Promise<OrganizationProfile | null> {
  return db.prepare("SELECT * FROM organization_profiles WHERE tenant_id = ?").bind(tenantId).first<OrganizationProfile>();
}

export async function markPhoneVerified(db: D1Database, tenantId: string, userId: string): Promise<void> {
  const ts = now();
  await db
    .prepare("UPDATE organization_profiles SET phone_verified_at = ?, phone_verified_by = ?, updated_at = ? WHERE tenant_id = ?")
    .bind(ts, userId, ts, tenantId)
    .run();
}

// ------------------------------------------------------------------- email codes

export type EmailCodePurpose = "signup";

/** How long a code stays valid, how often one may be resent, and how many guesses it allows. */
export const EMAIL_CODE_TTL_SECONDS = 600;
export const EMAIL_CODE_RESEND_SECONDS = 60;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

function codeId(purpose: EmailCodePurpose, email: string): string {
  return `${purpose}:${email.toLowerCase()}`;
}

async function codeHash(purpose: EmailCodePurpose, email: string, code: string): Promise<string> {
  return sha256Hex(`${codeId(purpose, email)}:${code}`);
}

/** Seconds until a new code may be sent to this address (0 when it may). */
export async function emailCodeCooldown(db: D1Database, purpose: EmailCodePurpose, email: string): Promise<number> {
  const row = await db
    .prepare("SELECT sent_at FROM email_codes WHERE id = ?")
    .bind(codeId(purpose, email))
    .first<{ sent_at: number }>();
  if (!row) return 0;
  return Math.max(0, row.sent_at + EMAIL_CODE_RESEND_SECONDS - now());
}

/** A uniformly random integer in [0, limit): draws past the last whole multiple are rejected, so no value is favoured. */
function uniformBelow(limit: number): number {
  const ceiling = Math.floor(0x1_0000_0000 / limit) * limit;
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0] < ceiling) return draw[0] % limit;
  }
}

/** A fresh six-digit code for this address, replacing any earlier one. */
export async function issueEmailCode(db: D1Database, purpose: EmailCodePurpose, email: string): Promise<string> {
  const code = String(uniformBelow(1_000_000)).padStart(6, "0");
  const ts = now();
  await db
    .prepare(
      `INSERT INTO email_codes (id, purpose, email, code_hash, attempts, expires_at, sent_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0,
         expires_at = excluded.expires_at, sent_at = excluded.sent_at`
    )
    .bind(codeId(purpose, email), purpose, email.toLowerCase(), await codeHash(purpose, email, code), ts + EMAIL_CODE_TTL_SECONDS, ts)
    .run();
  return code;
}

export async function discardEmailCode(db: D1Database, purpose: EmailCodePurpose, email: string): Promise<void> {
  await db.prepare("DELETE FROM email_codes WHERE id = ?").bind(codeId(purpose, email)).run();
}

/**
 * Check a code. A wrong guess counts against the code, which is discarded after
 * EMAIL_CODE_MAX_ATTEMPTS; a correct one is left in place for the caller to
 * discard once the step it guards has succeeded.
 */
export async function checkEmailCode(
  db: D1Database,
  purpose: EmailCodePurpose,
  email: string,
  code: string
): Promise<"ok" | "wrong" | "expired"> {
  const id = codeId(purpose, email);
  const row = await db
    .prepare("SELECT code_hash, attempts, expires_at FROM email_codes WHERE id = ?")
    .bind(id)
    .first<{ code_hash: string; attempts: number; expires_at: number }>();
  if (!row || row.expires_at <= now() || row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return "expired";
  const supplied = await codeHash(purpose, email, String(code).trim());
  if (supplied === row.code_hash) return "ok";
  if (row.attempts + 1 >= EMAIL_CODE_MAX_ATTEMPTS) {
    await discardEmailCode(db, purpose, email);
  } else {
    await db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").bind(id).run();
  }
  return "wrong";
}

/** Drop codes that can no longer be used (hourly cron). */
export async function purgeExpiredEmailCodes(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM email_codes WHERE expires_at <= ?").bind(now()).run();
}
