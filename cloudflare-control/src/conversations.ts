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

/**
 * What a conversation is about (migration 0024). It names the prefix of the
 * tracking id and the type the console files it under: `box` is the tab.
 */
export const CATEGORIES = {
  registration: { prefix: "REG", label: "Registration", box: "tasks" },
  remote_control: { prefix: "RMT", label: "Remote Control", box: "tasks" },
  support: { prefix: "SUP", label: "Support", box: "support" },
  sales: { prefix: "SAL", label: "Sales", box: "support" },
  billing: { prefix: "BIL", label: "Billing", box: "support" },
  legal: { prefix: "LGL", label: "Legal & privacy", box: "support" },
  general: { prefix: "GEN", label: "General", box: "support" },
  letter: { prefix: "LTR", label: "Letters", box: "support" }
} as const;
export type ConversationCategory = keyof typeof CATEGORIES;

export function isCategory(value: unknown): value is ConversationCategory {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CATEGORIES, value);
}

/** The label a customer and the console read for a category; "General" for one not known. */
export function categoryLabel(category: string | null | undefined): string {
  return isCategory(category) ? CATEGORIES[category].label : CATEGORIES.general.label;
}

/** The part of an address before the `@` that says what mail to it is about. */
const MAILBOX_CATEGORIES: Record<string, ConversationCategory> = {
  support: "support",
  help: "support",
  helpdesk: "support",
  sales: "sales",
  quote: "sales",
  quotes: "sales",
  pricing: "sales",
  licensing: "sales",
  billing: "billing",
  accounts: "billing",
  invoice: "billing",
  invoices: "billing",
  payments: "billing",
  legal: "legal",
  privacy: "legal",
  abuse: "legal",
  security: "legal",
  compliance: "legal",
  dpo: "legal"
};

/** What mail to a platform address is about: `sales@` is sales, an address not listed is general. */
export function categoryForMailbox(mailbox: string | null | undefined): ConversationCategory {
  const address = String(mailbox || "").toLowerCase();
  const at = address.indexOf("@");
  const local = (at > 0 ? address.slice(0, at) : address).split("+")[0];
  return MAILBOX_CATEGORIES[local] ?? "general";
}

/** What a contact form message is about, from the topic the visitor chose. */
export function categoryForTopic(topic: string): ConversationCategory {
  const text = topic.toLowerCase();
  if (/sales|pricing|quote|licen|purchase|demo/.test(text)) return "sales";
  if (/billing|invoice|payment/.test(text)) return "billing";
  if (/legal|privacy|security|abuse/.test(text)) return "legal";
  if (/support|help|technical|problem|bug/.test(text)) return "support";
  return "general";
}

/**
 * What the contact page lets a person write about. Each is a type of mail, so
 * a message arrives in the Super Admin console already sorted.
 */
export const CONTACT_REASONS: readonly { value: ConversationCategory; label: string }[] = [
  { value: "sales", label: "Sales and licensing" },
  { value: "support", label: "Technical support" },
  { value: "billing", label: "Billing and invoices" },
  { value: "legal", label: "Privacy, security or legal" },
  { value: "general", label: "Something else" }
];

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
  /** The platform address a mail conversation belongs to (`support@labkiosk.org`); null for a task. */
  mailbox: string | null;
  /** What it is about; names the tracking id's prefix and the type it is filed under (migration 0024). */
  category: ConversationCategory;
  /** When a mail conversation was moved to Deleted (migration 0022); null while it is not. */
  deleted_at: number | null;
}

/** An attachment as the message list shows it; the bytes stay in the stored original. */
export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
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
  /** Where the original message is kept in R2, for an inbound email. */
  raw_key: string | null;
  /** JSON list of `AttachmentInfo`, or null. */
  attachments: string | null;
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

/** Every prefix a tracking id can start with. `LK` is what all of them carried before 0024. */
const REFERENCE_PREFIXES = ["LK", ...Object.values(CATEGORIES).map((c) => c.prefix)];
const REFERENCE_PATTERN = `(?:${REFERENCE_PREFIXES.join("|")})-[A-Z0-9]{6}`;

/** A tracking id such as SUP-7Q2M9X, carried in every email subject: the category's prefix and six characters. */
export function newReference(category: ConversationCategory = "general"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${CATEGORIES[category].prefix}-` + Array.from(bytes, (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join("");
}

/** The tracking id a subject carries, e.g. "Re: [SUP-7Q2M9X] Your question". */
export function referenceInSubject(subject: string): string | null {
  const match = subject.match(new RegExp(`\\[(${REFERENCE_PATTERN})\\]`, "i"));
  return match ? match[1].toUpperCase() : null;
}

/** "[SUP-7Q2M9X] subject", without stacking a second tracking id. */
export function subjectWithReference(reference: string, subject: string): string {
  const clean = subject.replace(new RegExp(`\\[${REFERENCE_PATTERN}\\]\\s*`, "gi"), "").trim();
  return `[${reference}] ${clean}`;
}

export async function createConversation(
  db: D1Database,
  data: {
    kind: ConversationKind;
    tenantId: string | null;
    subject: string;
    contactEmail: string;
    contactName?: string | null;
    mailbox?: string | null;
    /** What it is about. Left out, a task is filed by its kind and mail by the address it was sent to. */
    category?: ConversationCategory;
    /** A conversation the platform starts (a new outgoing email) has nothing unread. */
    unread?: boolean;
  }
): Promise<Conversation> {
  const ts = now();
  const category: ConversationCategory =
    data.kind === "signup"
      ? "registration"
      : data.kind === "remote_control"
        ? "remote_control"
        : (data.category ?? categoryForMailbox(data.mailbox));
  // A collision on the unique reference is astronomically unlikely, and it
  // fails loudly rather than threading two requests together.
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    kind: data.kind,
    tenant_id: data.tenantId,
    reference: newReference(category),
    subject: data.subject.slice(0, 300),
    contact_email: data.contactEmail.toLowerCase(),
    contact_name: data.contactName ? data.contactName.slice(0, 120) : null,
    status: "open",
    unread: data.unread === false ? 0 : 1,
    created_at: ts,
    updated_at: ts,
    last_message_at: ts,
    resolved_at: null,
    resolved_by: null,
    mailbox: data.mailbox ? data.mailbox.toLowerCase() : null,
    category,
    deleted_at: null
  };
  await db
    .prepare(
      `INSERT INTO conversations (id, kind, tenant_id, reference, subject, contact_email, contact_name, status, unread, created_at, updated_at, last_message_at, mailbox, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      conversation.id,
      conversation.kind,
      conversation.tenant_id,
      conversation.reference,
      conversation.subject,
      conversation.contact_email,
      conversation.contact_name,
      conversation.unread,
      ts,
      ts,
      ts,
      conversation.mailbox,
      conversation.category
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
    /** Set when the caller already named the message (its stored original is keyed by it). */
    id?: string;
    rawKey?: string | null;
    attachments?: AttachmentInfo[] | null;
  }
): Promise<ConversationMessage> {
  const ts = now();
  const message: ConversationMessage = {
    id: data.id ?? crypto.randomUUID(),
    conversation_id: data.conversationId,
    direction: data.direction,
    from_address: data.fromAddress ?? null,
    to_address: data.toAddress ?? null,
    subject: data.subject ?? null,
    body: data.body.slice(0, MAX_MESSAGE_CHARS),
    email_message_id: data.emailMessageId ?? null,
    author_user_id: data.authorUserId ?? null,
    delivery: data.delivery ?? null,
    raw_key: data.rawKey ?? null,
    attachments: data.attachments?.length ? JSON.stringify(data.attachments) : null,
    created_at: ts
  };
  // An inbound message is what the platform owner has not read yet, and an
  // answer to a conversation in Deleted brings it back rather than hiding there.
  const inbound = data.direction === "inbound";
  const unread = inbound ? 1 : null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO conversation_messages (id, conversation_id, direction, from_address, to_address, subject, body, email_message_id, author_user_id, delivery, raw_key, attachments, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        message.raw_key,
        message.attachments,
        ts
      ),
    db
      .prepare(
        `UPDATE conversations SET last_message_at = ?, updated_at = ?, unread = COALESCE(?, unread)${inbound ? ", deleted_at = NULL" : ""} WHERE id = ?`
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

/** The views of a box: by status, by read state, or what was moved to Deleted. */
export const CONVERSATION_FILTERS = ["open", "closed", "all", "unread", "read", "deleted"] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

const FILTER_CLAUSES: Record<ConversationFilter, string> = {
  open: "AND c.status = 'open' AND c.deleted_at IS NULL",
  closed: "AND c.status <> 'open' AND c.deleted_at IS NULL",
  all: "AND c.deleted_at IS NULL",
  unread: "AND c.unread = 1 AND c.deleted_at IS NULL",
  read: "AND c.unread = 0 AND c.deleted_at IS NULL",
  deleted: "AND c.deleted_at IS NOT NULL"
};

/**
 * One box of the inbox. Open items come first, oldest first -- the order they
 * should be worked in -- then everything else, most recent first. Only the
 * `deleted` view shows what was moved to Deleted.
 */
export async function listConversations(
  db: D1Database,
  kinds: readonly ConversationKind[],
  filter: ConversationFilter,
  limit = 200,
  mailbox: string | null = null,
  category: ConversationCategory | null = null
): Promise<ConversationListRow[]> {
  const marks = kinds.map(() => "?").join(", ");
  const statusClause = FILTER_CLAUSES[filter];
  const mailboxClause = mailbox ? "AND c.mailbox = ?" : "";
  const categoryClause = category ? "AND c.category = ?" : "";
  const result = await db
    .prepare(
      `SELECT c.*, t.name AS organization_name, t.subdomain AS organization_subdomain,
              (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c LEFT JOIN tenants t ON t.id = c.tenant_id
       WHERE c.kind IN (${marks}) ${statusClause} ${mailboxClause} ${categoryClause}
       ORDER BY CASE WHEN c.status = 'open' THEN 0 ELSE 1 END,
                CASE WHEN c.status = 'open' THEN c.created_at ELSE -c.last_message_at END
       LIMIT ?`
    )
    .bind(...kinds, ...(mailbox ? [mailbox.toLowerCase()] : []), ...(category ? [category] : []), Math.max(1, Math.min(500, limit)))
    .all<ConversationListRow>();
  return result.results || [];
}

/** Open items per box, and unread and deleted support conversations, for the console's badges. */
export async function inboxCounts(
  db: D1Database
): Promise<{ openTasks: number; openSupport: number; unreadSupport: number; deletedSupport: number }> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN kind IN ('signup', 'remote_control') AND status = 'open' THEN 1 ELSE 0 END) AS open_tasks,
         SUM(CASE WHEN kind = 'support' AND status = 'open' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS open_support,
         SUM(CASE WHEN kind = 'support' AND unread = 1 AND deleted_at IS NULL THEN 1 ELSE 0 END) AS unread_support,
         SUM(CASE WHEN kind = 'support' AND deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_support
       FROM conversations`
    )
    .first<{ open_tasks: number | null; open_support: number | null; unread_support: number | null; deleted_support: number | null }>();
  return {
    openTasks: Number(row?.open_tasks || 0),
    openSupport: Number(row?.open_support || 0),
    unreadSupport: Number(row?.unread_support || 0),
    deletedSupport: Number(row?.deleted_support || 0)
  };
}

export interface CategoryCount {
  id: ConversationCategory;
  label: string;
  prefix: string;
  open: number;
  total: number;
}

/** Every type a box files under, with its open and total conversations (Deleted left out). */
export async function categoryCounts(db: D1Database, box: "tasks" | "support"): Promise<CategoryCount[]> {
  const result = await db
    .prepare(
      `SELECT category,
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
              COUNT(*) AS total
       FROM conversations WHERE deleted_at IS NULL GROUP BY category`
    )
    .all<{ category: string; open: number | null; total: number | null }>();
  const rows = new Map((result.results || []).map((r) => [r.category, r]));
  return (Object.keys(CATEGORIES) as ConversationCategory[])
    .filter((id) => CATEGORIES[id].box === box)
    .map((id) => ({
      id,
      label: CATEGORIES[id].label,
      prefix: CATEGORIES[id].prefix,
      open: Number(rows.get(id)?.open || 0),
      total: Number(rows.get(id)?.total || 0)
    }));
}

export interface MailboxCount {
  mailbox: string;
  open: number;
  unread: number;
  total: number;
}

/** Every address mail has arrived at or been sent from, with its open and unread conversations. */
export async function mailboxCounts(db: D1Database): Promise<MailboxCount[]> {
  const result = await db
    .prepare(
      `SELECT mailbox,
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN unread = 1 THEN 1 ELSE 0 END) AS unread,
              COUNT(*) AS total
       FROM conversations WHERE kind = 'support' AND mailbox IS NOT NULL AND deleted_at IS NULL
       GROUP BY mailbox ORDER BY mailbox LIMIT 200`
    )
    .all<{ mailbox: string; open: number | null; unread: number | null; total: number | null }>();
  return (result.results || []).map((r) => ({
    mailbox: r.mailbox,
    open: Number(r.open || 0),
    unread: Number(r.unread || 0),
    total: Number(r.total || 0)
  }));
}

/** Delete a conversation and its messages; returns the stored originals to delete from R2. */
export async function deleteConversation(db: D1Database, id: string): Promise<string[]> {
  const keys = await db
    .prepare("SELECT raw_key FROM conversation_messages WHERE conversation_id = ? AND raw_key IS NOT NULL")
    .bind(id)
    .all<{ raw_key: string }>();
  await db.batch([
    db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").bind(id),
    db.prepare("DELETE FROM conversations WHERE id = ?").bind(id)
  ]);
  return (keys.results || []).map((r) => r.raw_key);
}

export async function findConversationMessage(db: D1Database, conversationId: string, messageId: string): Promise<ConversationMessage | null> {
  return db
    .prepare("SELECT * FROM conversation_messages WHERE id = ? AND conversation_id = ?")
    .bind(messageId, conversationId)
    .first<ConversationMessage>();
}

export async function listConversationMessages(db: D1Database, conversationId: string): Promise<ConversationMessage[]> {
  const result = await db
    .prepare("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC")
    .bind(conversationId)
    .all<ConversationMessage>();
  return result.results || [];
}

export async function markConversationRead(db: D1Database, id: string, read = true): Promise<void> {
  await db.prepare("UPDATE conversations SET unread = ? WHERE id = ?").bind(read ? 0 : 1, id).run();
}

/** Move a conversation to Deleted, or back out of it. Nothing is removed. */
export async function setConversationDeleted(db: D1Database, id: string, deleted: boolean): Promise<void> {
  const ts = now();
  await db.prepare("UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(deleted ? ts : null, ts, id).run();
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

export type EmailCodePurpose = "signup" | "contact";

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
export function uniformBelow(limit: number): number {
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
