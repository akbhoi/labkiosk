/**
 * The Super Admin console's Tasks and Mail, and the email they run on.
 *
 * - `/api/super/inbox...` (super admin only): list (by mailbox), read, reply,
 *   write a new email, add a note, approve or reject a task, mark a signup's
 *   phone as verified, mark unread, close or reopen a mail conversation, move
 *   it to Deleted, restore it or delete it for good, and
 *   download an inbound message's attachments or original. Every reply goes
 *   out as email from here.
 * - `fileStoredInboundMail()`: mail the `labkiosk-email-routing` Worker
 *   received (every address on the mail domain, through the catch-all) and
 *   stored in R2, handed over through `MailIntake` (src/index.ts).
 *   `handleInboundEmail()` does the same for mail routed straight to this
 *   Worker's own `email()` handler. Either way the message is kept
 *   whole in R2 and filed into its conversation by the `[SUP-XXXXXX]` tracking id
 *   in the subject or by its threading headers, and only when it comes from
 *   that conversation's own contact; anything else starts a new conversation
 *   in the mailbox it was sent to.
 */

import { Env } from "./types";
import { jsonError, requireSuperAdmin } from "./guard";
import { findTenantById, findUserById, updateTenant, writeAuditLog } from "./db";
import { notifyConfigChanged } from "./hub";
import {
  addConversationMessage,
  AttachmentInfo,
  categoryCounts,
  categoryForMailbox,
  categoryLabel,
  Conversation,
  CONVERSATION_FILTERS,
  ConversationFilter,
  ConversationKind,
  createConversation,
  deleteConversation,
  findConversation,
  findConversationMessage,
  findConversationByEmailMessageIds,
  findConversationByReference,
  findOrganizationProfile,
  inboxCounts,
  isCategory,
  listConversationMessages,
  listConversations,
  mailboxCounts,
  markConversationRead,
  markPhoneVerified,
  MAX_MESSAGE_CHARS,
  referenceInSubject,
  setConversationDeleted,
  setConversationStatus,
  TASK_KINDS
} from "./conversations";
import { mailConfigProblem, mailDomain, parseAddress, sendingDomain } from "./mail";
import { clearPendingMail, deleteRawMail, isMailId, listPendingMail, loadRawMail, rawMailKey, storeRawMail } from "./mail_store";
import { extractAttachment, parseEmail } from "./mime";
import { consoleUrlFor, RouteContext, sendOnConversation } from "./signup";

const SUPPORT_KINDS: readonly ConversationKind[] = ["support"];
const INBOX_PATH =
  /^\/api\/super\/inbox(?:\/compose|\/([0-9a-f-]{36})(?:\/(reply|note|approve|reject|verify-phone|status|unread|trash|restore|delete)|\/attachment\/([0-9a-f-]{36})\/(original|\d{1,2}))?)?$/;
/** Email Routing's own limit: nothing larger reaches the Worker. */
const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
/** Inbound messages larger than this are filed from their headers; the stored original is whole. */
const MAX_PARSED_BYTES = 10 * 1024 * 1024;
/** A mailbox name: the part before the `@` (`support`, `first.last`). */
const MAILBOX_LOCAL = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

function json(data: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

async function readMessage(request: Request): Promise<{ message: string; close: boolean; status: string } | null> {
  try {
    const body = await request.json<{ message?: unknown; close?: unknown; status?: unknown }>();
    return {
      message: String(body?.message ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_MESSAGE_CHARS),
      close: body?.close === true,
      status: String(body?.status ?? "")
    };
  } catch {
    return null;
  }
}

/** The threading headers for a reply: the newest message the customer sent, and the chain. */
async function threadingFor(db: D1Database, conversation: Conversation): Promise<{ inReplyTo: string | null; references: string[] }> {
  const messages = await listConversationMessages(db, conversation.id);
  const ids = messages.map((m) => m.email_message_id).filter((id): id is string => Boolean(id && id.startsWith("<")));
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound" && m.email_message_id);
  return { inReplyTo: lastInbound?.email_message_id ?? null, references: ids };
}

/** A file to save, never to render: the bytes come from a stranger's email. */
function download(bytes: Uint8Array, filename: string): Response {
  let ascii = "";
  for (const ch of filename) ascii += /^[\x20-\x7e]$/.test(ch) && ch !== '"' && ch !== "\\" ? ch : "_";
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${ascii || "attachment"}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

/** How a letter is dated: "9 October 2026", in the platform's own time zone. */
const LETTER_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

/** POST /api/super/inbox/compose: start a conversation with an email written as one of the platform's addresses. */
async function handleCompose(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, request, session } = ctx;
  const problem = mailConfigProblem(env);
  if (problem) return jsonError(problem, 503, jsonHeaders);
  const domain = mailDomain(env);
  if (!domain) return jsonError("Set SUPPORT_ADDRESS to say which domain the mailboxes are on", 503, jsonHeaders);
  let body: {
    from?: unknown;
    to?: unknown;
    subject?: unknown;
    message?: unknown;
    format?: unknown;
    organization?: unknown;
    signatoryTitle?: unknown;
  };
  try {
    body = await request.json<typeof body>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const fromInput = String(body?.from ?? "").trim().toLowerCase();
  const fromLocal = fromInput.includes("@") ? (fromInput.endsWith(`@${domain}`) ? fromInput.slice(0, -(domain.length + 1)) : "") : fromInput;
  if (!MAILBOX_LOCAL.test(fromLocal)) return jsonError(`Send from an address on ${domain}`, 400, jsonHeaders);
  const to = parseAddress(String(body?.to ?? ""));
  if (!to) return jsonError("Enter the recipient's email address", 400, jsonHeaders);
  const toDomain = to.email.slice(to.email.indexOf("@") + 1);
  if (toDomain === domain || toDomain === sendingDomain(env)) {
    return jsonError("That address is one of the platform's own mailboxes", 400, jsonHeaders);
  }
  const subject = String(body?.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!subject) return jsonError("Write a subject", 400, jsonHeaders);
  const message = String(body?.message ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return jsonError("Write the message first", 400, jsonHeaders);

  // A formal letter to a company, or an ordinary message.
  const letter = body?.format === "letter";
  const organization = String(body?.organization ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const signatoryTitle = String(body?.signatoryTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

  const userId = session!.user_id;
  const author = (await findUserById(db, userId))?.name || null;
  const conversation = await createConversation(db, {
    kind: "support",
    tenantId: null,
    subject,
    contactEmail: to.email,
    contactName: to.name || null,
    mailbox: `${fromLocal}@${domain}`,
    category: letter ? "letter" : undefined,
    unread: false
  });
  const sent = await sendOnConversation(env, db, conversation, message, {
    authorUserId: userId,
    authorName: author,
    template: letter
      ? {
          name: "letter",
          reference: conversation.reference,
          date: LETTER_DATE.format(new Date()),
          recipientName: to.name || null,
          recipientOrganization: organization || null,
          heading: subject,
          signatory: author,
          signatoryTitle: signatoryTitle || null
        }
      : undefined
  });
  await writeAuditLog(db, {
    tenantId: null,
    userId,
    action: "inbox.compose",
    details: `reference=${conversation.reference} mailbox=${conversation.mailbox} delivered=${sent}`
  });
  if (!sent) {
    return json({ error: "The message was saved but could not be sent. Open it to try again.", id: conversation.id }, jsonHeaders, 502);
  }
  return json({ status: "ok", id: conversation.id }, jsonHeaders);
}

/** True when the path is one of this module's routes. */
export function isInboxRoute(path: string): boolean {
  return INBOX_PATH.test(path);
}

/** Every `/api/super/inbox` route. The caller checked `isInboxRoute()`. */
export async function handleInboxRoute(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, request, session, url } = ctx;
  const denied = requireSuperAdmin(session, jsonHeaders);
  if (denied) return denied;
  const match = url.pathname.match(INBOX_PATH)!;
  const id = match[1];
  const action = match[2];
  const attachmentMessageId = match[3];
  const attachmentIndex = match[4];
  const method = request.method;

  // POST /api/super/inbox/compose { from, to, subject, message }: a new email.
  if (!id && url.pathname.endsWith("/compose")) {
    if (method !== "POST") return jsonError("Method not allowed", 405, jsonHeaders);
    return handleCompose(ctx);
  }

  // GET /api/super/inbox?box=tasks|support&filter=open|closed|all|unread|read|deleted&mailbox=<address>&category=<type>
  if (!id) {
    if (method !== "GET") return jsonError("Method not allowed", 405, jsonHeaders);
    const box = url.searchParams.get("box") === "support" ? "support" : "tasks";
    const filterParam = url.searchParams.get("filter");
    const filter: ConversationFilter = (CONVERSATION_FILTERS as readonly string[]).includes(filterParam || "")
      ? (filterParam as ConversationFilter)
      : "open";
    const mailbox = box === "support" ? (parseAddress(url.searchParams.get("mailbox") || "")?.email ?? null) : null;
    const categoryParam = url.searchParams.get("category");
    const category = isCategory(categoryParam) ? categoryParam : null;
    const items = await listConversations(db, box === "support" ? SUPPORT_KINDS : TASK_KINDS, filter, 200, mailbox, category);
    return json(
      {
        box,
        filter,
        mailbox,
        category,
        items,
        categories: await categoryCounts(db, box),
        counts: await inboxCounts(db),
        mailboxes: box === "support" ? await mailboxCounts(db) : [],
        mailDomain: mailDomain(env)
      },
      jsonHeaders
    );
  }

  const conversation = await findConversation(db, id);
  if (!conversation) return jsonError("No such conversation", 404, jsonHeaders);

  // GET .../attachment/<message id>/<index|original>: one attachment, or the whole message.
  if (attachmentMessageId) {
    if (method !== "GET") return jsonError("Method not allowed", 405, jsonHeaders);
    const message = await findConversationMessage(db, id, attachmentMessageId);
    if (!message?.raw_key) return jsonError("This message has no stored original", 404, jsonHeaders);
    const raw = await loadRawMail(env, message.raw_key);
    if (!raw) return jsonError("The stored original of this message is gone", 404, jsonHeaders);
    if (attachmentIndex === "original") return download(raw, `${conversation.reference}.eml`);
    const found = extractAttachment(raw, Number(attachmentIndex));
    if (!found) return jsonError("This message has no such attachment", 404, jsonHeaders);
    return download(found.bytes, found.attachment.filename);
  }

  // POST .../trash and .../restore: a mail conversation into Deleted and back. Nothing is removed.
  if (action === "trash" || action === "restore") {
    if (method !== "POST") return jsonError("Method not allowed", 405, jsonHeaders);
    if (conversation.kind !== "support") return jsonError("Tasks stay on record and cannot be deleted", 400, jsonHeaders);
    const deleted = action === "trash";
    if (Boolean(conversation.deleted_at) !== deleted) {
      await setConversationDeleted(db, id, deleted);
      await writeAuditLog(db, {
        tenantId: conversation.tenant_id,
        userId: session!.user_id,
        action: deleted ? "inbox.trash" : "inbox.restore",
        details: `reference=${conversation.reference} mailbox=${conversation.mailbox || "-"}`
      });
    }
    return json({ status: "ok", deleted }, jsonHeaders);
  }

  // POST .../delete: a mail conversation in Deleted, its messages and their stored originals, for good.
  if (action === "delete") {
    if (method !== "POST") return jsonError("Method not allowed", 405, jsonHeaders);
    if (conversation.kind !== "support") return jsonError("Tasks stay on record and cannot be deleted", 400, jsonHeaders);
    if (!conversation.deleted_at) return jsonError("Move the conversation to Deleted first", 409, jsonHeaders);
    const keys = (await listConversationMessages(db, id)).map((m) => m.raw_key).filter((key): key is string => Boolean(key));
    try {
      await deleteRawMail(env, keys);
    } catch (err) {
      console.error(`[Inbox] Deleting the stored mail of ${conversation.reference} failed:`, err);
      return jsonError("The stored messages could not be deleted. Nothing was removed; try again.", 502, jsonHeaders);
    }
    await deleteConversation(db, id);
    await writeAuditLog(db, {
      tenantId: conversation.tenant_id,
      userId: session!.user_id,
      action: "inbox.delete",
      details: `reference=${conversation.reference} mailbox=${conversation.mailbox || "-"}`
    });
    return json({ status: "ok" }, jsonHeaders);
  }
  const tenant = conversation.tenant_id ? await findTenantById(db, conversation.tenant_id) : null;

  // GET /api/super/inbox/<id>: the whole conversation, marked read.
  if (!action) {
    if (method !== "GET") return jsonError("Method not allowed", 405, jsonHeaders);
    await markConversationRead(db, id);
    const messages = await listConversationMessages(db, id);
    const authors = new Map<string, string>();
    for (const m of messages) {
      if (m.author_user_id && !authors.has(m.author_user_id)) {
        authors.set(m.author_user_id, (await findUserById(db, m.author_user_id))?.name || "Platform");
      }
    }
    const profile = tenant ? await findOrganizationProfile(db, tenant.id) : null;
    return json(
      {
        conversation: { ...conversation, unread: 0 },
        messages: messages.map((m) => ({ ...m, author_name: m.author_user_id ? authors.get(m.author_user_id) : null })),
        organization: tenant
          ? {
              id: tenant.id,
              name: tenant.name,
              subdomain: tenant.subdomain,
              status: tenant.status,
              remoteControlStatus: tenant.remote_control_status || "none",
              createdAt: tenant.created_at
            }
          : null,
        profile,
        mailProblem: mailConfigProblem(env)
      },
      jsonHeaders
    );
  }

  if (method !== "POST") return jsonError("Method not allowed", 405, jsonHeaders);
  const input = await readMessage(request);
  if (!input) return jsonError("The request body must be JSON", 400, jsonHeaders);
  const userId = session!.user_id;

  // POST .../unread: back among the unread, as it was before it was opened.
  if (action === "unread") {
    await markConversationRead(db, id, false);
    return json({ status: "ok" }, jsonHeaders);
  }

  // POST .../note { message }: visible only here.
  if (action === "note") {
    if (!input.message) return jsonError("Write the note first", 400, jsonHeaders);
    await addConversationMessage(db, { conversationId: id, direction: "note", body: input.message, authorUserId: userId });
    return json({ status: "ok" }, jsonHeaders);
  }

  // POST .../reply { message, close? }: email the contact.
  if (action === "reply") {
    if (!input.message) return jsonError("Write the reply first", 400, jsonHeaders);
    const problem = mailConfigProblem(env);
    if (problem) return jsonError(problem, 503, jsonHeaders);
    const threading = await threadingFor(db, conversation);
    const sent = await sendOnConversation(env, db, conversation, input.message, {
      subject: conversation.subject.startsWith("Re:") ? conversation.subject : `Re: ${conversation.subject}`,
      authorUserId: userId,
      authorName: (await findUserById(db, userId))?.name || null,
      ...threading
    });
    if (input.close && conversation.kind === "support") await setConversationStatus(db, id, "closed", userId);
    await writeAuditLog(db, {
      tenantId: conversation.tenant_id,
      userId,
      action: "inbox.reply",
      details: `reference=${conversation.reference} delivered=${sent}`
    });
    if (!sent) return jsonError("The reply was saved but the email could not be sent. Try again later.", 502, jsonHeaders);
    return json({ status: "ok" }, jsonHeaders);
  }

  // POST .../status { status: open|closed }: support conversations only.
  if (action === "status") {
    if (conversation.kind !== "support") return jsonError("Tasks are closed by approving or rejecting them", 400, jsonHeaders);
    if (input.status !== "open" && input.status !== "closed") return jsonError("Status must be open or closed", 400, jsonHeaders);
    await setConversationStatus(db, id, input.status, userId);
    return json({ status: "ok", conversationStatus: input.status }, jsonHeaders);
  }

  // The remaining actions decide a task.
  if (conversation.kind === "support") return jsonError("Support conversations are not approved or rejected", 400, jsonHeaders);
  if (!tenant) return jsonError("The organization this request belongs to no longer exists", 404, jsonHeaders);
  const profile = await findOrganizationProfile(db, tenant.id);

  // POST .../verify-phone: the owner confirmed the number (call, message).
  if (action === "verify-phone") {
    if (conversation.kind !== "signup") return jsonError("Only a registration has a phone number to verify", 400, jsonHeaders);
    if (!profile) return jsonError("This registration has no contact details", 404, jsonHeaders);
    if (profile.phone_verified_at) return json({ status: "ok", phoneVerifiedAt: profile.phone_verified_at }, jsonHeaders);
    await markPhoneVerified(db, tenant.id, userId);
    await addConversationMessage(db, {
      conversationId: id,
      direction: "event",
      body: `Phone number ${profile.contact_phone} marked as verified.`,
      authorUserId: userId
    });
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "tenant.verify_phone" });
    return json({ status: "ok" }, jsonHeaders);
  }

  if (conversation.status !== "open") return jsonError("This task has already been decided", 409, jsonHeaders);
  const problem = mailConfigProblem(env);
  if (problem) return jsonError(problem, 503, jsonHeaders);
  const threading = await threadingFor(db, conversation);
  const note = input.message ? `\n\n${input.message}` : "";

  if (action === "approve" && conversation.kind === "signup") {
    if (tenant.status !== "pending") return jsonError("This organization is not waiting for approval", 409, jsonHeaders);
    if (!profile?.email_verified_at) return jsonError("The email address has not been verified", 409, jsonHeaders);
    if (!profile.phone_verified_at) return jsonError("Verify the phone number before approving", 409, jsonHeaders);
    await updateTenant(db, tenant.id, { status: "active" });
    await setConversationStatus(db, id, "approved", userId);
    await addConversationMessage(db, { conversationId: id, direction: "event", body: "Registration approved.", authorUserId: userId });
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "tenant.approve", details: `subdomain=${tenant.subdomain}` });
    await notifyConfigChanged(env, tenant.id);
    const sent = await sendOnConversation(
      env,
      db,
      conversation,
      `Hello ${conversation.contact_name || ""},\n\n` +
        `${tenant.name} is now active on Lab Kiosk.${note}\n\n` +
        `Sign in to your console with the email address and password you registered with:\n${consoleUrlFor(ctx, tenant.subdomain)}\n\n` +
        `Your enrollment key and the setup steps for your workstations are under Settings.\n\nLab Kiosk`,
      {
        subject: "Your organization is active",
        authorUserId: userId,
        ...threading,
        template: {
          name: "decision",
          reference: conversation.reference,
          outcome: "approved",
          title: "Your organization is active",
          category: categoryLabel(conversation.category),
          action: { label: "Open your console", url: consoleUrlFor(ctx, tenant.subdomain) }
        }
      }
    );
    return json({ status: "ok", emailSent: sent }, jsonHeaders);
  }

  if (action === "reject" && conversation.kind === "signup") {
    if (tenant.status !== "pending") return jsonError("This organization is not waiting for approval", 409, jsonHeaders);
    await updateTenant(db, tenant.id, { status: "rejected" });
    await setConversationStatus(db, id, "rejected", userId);
    await addConversationMessage(db, { conversationId: id, direction: "event", body: "Registration rejected.", authorUserId: userId });
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "tenant.reject" });
    await notifyConfigChanged(env, tenant.id);
    const sent = await sendOnConversation(
      env,
      db,
      conversation,
      `Hello ${conversation.contact_name || ""},\n\n` +
        `We are not able to activate ${tenant.name} on Lab Kiosk at this time.${note}\n\n` +
        `Reply to this email if you would like to discuss it.\n\nLab Kiosk`,
      {
        subject: "About your registration",
        authorUserId: userId,
        ...threading,
        template: {
          name: "decision",
          reference: conversation.reference,
          outcome: "declined",
          title: "About your registration",
          category: categoryLabel(conversation.category)
        }
      }
    );
    return json({ status: "ok", emailSent: sent }, jsonHeaders);
  }

  if ((action === "approve" || action === "reject") && conversation.kind === "remote_control") {
    if (tenant.status !== "active") return jsonError("The organization is not active", 409, jsonHeaders);
    const approve = action === "approve";
    await updateTenant(db, tenant.id, { remote_control_status: approve ? "approved" : "rejected" });
    await setConversationStatus(db, id, approve ? "approved" : "rejected", userId);
    await addConversationMessage(db, {
      conversationId: id,
      direction: "event",
      body: approve ? "Remote Control approved." : "Remote Control request rejected.",
      authorUserId: userId
    });
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: approve ? "remote_control.approve" : "remote_control.reject" });
    const sent = await sendOnConversation(
      env,
      db,
      conversation,
      approve
        ? `Hello ${conversation.contact_name || ""},\n\nRemote Control is now available to ${tenant.name}.${note}\n\n` +
            `Open Workstations in your console and choose Remote Control on any connected workstation:\n${consoleUrlFor(ctx, tenant.subdomain)}\n\nLab Kiosk`
        : `Hello ${conversation.contact_name || ""},\n\nWe are not able to turn on Remote Control for ${tenant.name} at this time.${note}\n\n` +
            `Reply to this email if you would like to discuss it.\n\nLab Kiosk`,
      {
        subject: approve ? "Remote Control is on" : "About your Remote Control request",
        authorUserId: userId,
        ...threading,
        template: {
          name: "decision",
          reference: conversation.reference,
          outcome: approve ? "approved" : "declined",
          title: approve ? "Remote Control is on" : "About your Remote Control request",
          category: categoryLabel(conversation.category),
          action: approve ? { label: "Open your console", url: consoleUrlFor(ctx, tenant.subdomain) } : null
        }
      }
    );
    return json({ status: "ok", emailSent: sent }, jsonHeaders);
  }

  return jsonError("Unknown action", 400, jsonHeaders);
}

// ----------------------------------------------------------------- inbound mail

/** The parts of `ForwardableEmailMessage` the handler uses (tests pass a stand-in). */
export interface InboundMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  readonly headers: Headers;
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

/** The message's headers with a note for a body, for mail too large to parse. */
function headersOnly(message: InboundMessage, note: string): Uint8Array {
  const lines: string[] = [];
  message.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n${note}`);
}

/** Header sections longer than this are cut: real ones are a few kilobytes. */
const MAX_HEADER_BYTES = 256 * 1024;

/** A stored original's header section with a note for a body, for mail too large to parse. */
function headerSectionOnly(raw: Uint8Array, note: string): Uint8Array {
  const limit = Math.min(raw.byteLength, MAX_HEADER_BYTES);
  // The header section ends at the first empty line; without one, all of it is headers.
  let end = -1;
  for (let i = 0; i + 1 < limit; i++) {
    if (raw[i] === 0x0a && (raw[i + 1] === 0x0a || (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a))) {
      end = i + 1;
      break;
    }
  }
  const head = raw.subarray(0, end < 0 ? limit : end);
  const tail = new TextEncoder().encode(end < 0 ? `\r\n\r\n${note}` : `\r\n${note}`);
  const out = new Uint8Array(head.byteLength + tail.byteLength);
  out.set(head);
  out.set(tail, head.byteLength);
  return out;
}

/** The whole message, or null when it is larger than anything Email Routing delivers. */
async function readRaw(message: InboundMessage): Promise<Uint8Array | null> {
  if (message.rawSize > MAX_INBOUND_BYTES) {
    await message.raw.cancel();
    return null;
  }
  return new Uint8Array(await new Response(message.raw).arrayBuffer());
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** One incoming message, however it arrived. */
interface IncomingMail {
  /** The id its conversation message gets; the original is stored under `rawMailKey(id)`. */
  id: string;
  /** Envelope sender and recipient. */
  from: string;
  to: string;
  /** What to parse: the original, or its headers with a note. */
  parsable: Uint8Array;
  /** Where the original is, or null when it is not stored. */
  rawKey: string | null;
}

/**
 * File one message into Mail. Returns the conversation it went to, or null
 * when it was dropped (from the platform's own sending domain: a loop).
 */
async function fileIncomingMail(env: Env, db: D1Database, mail: IncomingMail): Promise<Conversation | null> {
  const parsed = parseEmail(mail.parsable);
  // Who wrote it (the From header, else the envelope) decides which thread it may join;
  // Reply-To, which anyone can set, only decides where answers go.
  const author = parsed.from || { address: mail.from.toLowerCase(), name: "" };
  const sender = parsed.replyTo || author;
  // Everything the platform sends is from the sending domain: mail from it is a loop.
  const own = sendingDomain(env);
  if (own && (domainOf(author.address) === own || domainOf(mail.from) === own)) {
    console.warn("[Inbox] Dropped a message from the platform's own sending domain (a mail loop).");
    return null;
  }

  // A known conversation, but only when the mail comes from that conversation's contact:
  // knowing a reference must not let a stranger write into someone else's thread.
  const reference = referenceInSubject(parsed.subject);
  let conversation =
    (reference ? await findConversationByReference(db, reference) : null) ||
    (await findConversationByEmailMessageIds(db, [parsed.inReplyTo || "", ...parsed.references]));
  if (conversation && conversation.contact_email !== author.address) conversation = null;

  const isNew = !conversation;
  if (!conversation) {
    const mailbox = parseAddress(mail.to)?.email ?? null;
    conversation = await createConversation(db, {
      kind: "support",
      tenantId: null,
      subject: parsed.subject || "(no subject)",
      contactEmail: sender.address,
      contactName: sender.name || null,
      mailbox,
      category: categoryForMailbox(mailbox)
    });
  } else if (conversation.kind === "support" && conversation.status === "closed" && !parsed.automated) {
    // The customer wrote again: the conversation needs attention again.
    await setConversationStatus(db, conversation.id, "open", null);
  }

  const attachments: AttachmentInfo[] = parsed.attachments.map((a) => ({
    index: a.index,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size
  }));
  await addConversationMessage(db, {
    id: mail.id,
    conversationId: conversation.id,
    direction: "inbound",
    body: (parsed.text || "(no text)") + (parsed.automated ? "\n\n[Automatic message]" : ""),
    fromAddress: sender.address,
    toAddress: mail.to.toLowerCase(),
    subject: parsed.subject,
    emailMessageId: parsed.messageId,
    rawKey: mail.rawKey,
    attachments
  });
  if (isNew && !parsed.automated) {
    await sendReceipt(env, db, conversation, mail.from, parsed.messageId);
  }
  return conversation;
}

/** Senders that are programs: a receipt to them is noise, or the start of a loop. */
const NO_RECEIPT_SENDER = /^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounces?|notifications?|alerts?|news(?:letter)?)(?:[+._-].*)?$/;
/** One receipt per sender in this long: a burst of mail from one address is answered once. */
const RECEIPT_GAP_SECONDS = 24 * 3600;

/**
 * Tell the sender of a new conversation that it arrived, with its tracking id.
 * Only a person gets one: not an automatic message, not a bounce (an empty
 * envelope sender), not a no-reply address, and not an address that was sent a
 * receipt in the last day. Best effort: the message is filed either way.
 */
async function sendReceipt(env: Env, db: D1Database, conversation: Conversation, envelopeFrom: string, messageId: string | null): Promise<void> {
  if (mailConfigProblem(env)) return;
  const local = conversation.contact_email.split("@")[0];
  if (!parseAddress(envelopeFrom) || NO_RECEIPT_SENDER.test(local)) return;
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM conversations WHERE contact_email = ? AND id <> ? AND created_at > ?")
    .bind(conversation.contact_email, conversation.id, Math.floor(Date.now() / 1000) - RECEIPT_GAP_SECONDS)
    .first<{ n: number }>();
  if (Number(recent?.n || 0) > 0) return;
  const type = categoryLabel(conversation.category);
  await sendOnConversation(
    env,
    db,
    conversation,
    `Hello${conversation.contact_name ? ` ${conversation.contact_name}` : ""},\n\n` +
      `Thank you for writing to Lab Kiosk. Your message "${conversation.subject}" has reached us, and a person will read it.\n\n` +
      `Your tracking ID is ${conversation.reference}. Reply to this email to add anything: keeping the tracking ID in the subject keeps it all in one place.\n\nLab Kiosk`,
    {
      subject: "We received your message",
      inReplyTo: messageId,
      references: messageId ? [messageId] : [],
      autoReply: true,
      template: { name: "receipt", reference: conversation.reference, category: type, title: "We received your message" }
    }
  );
}

/**
 * The controller's own `email()` handler, for mail routed straight to it.
 * Returns the conversation it went to, or null when it was dropped.
 */
export async function handleInboundEmail(message: InboundMessage, env: Env, db: D1Database): Promise<Conversation | null> {
  const raw = await readRaw(message);
  const sizeKb = Math.max(1, Math.round(message.rawSize / 1024));
  const parsable =
    raw === null
      ? headersOnly(message, `(This message was ${sizeKb} KB, too large to receive here.)`)
      : raw.byteLength > MAX_PARSED_BYTES
        ? headersOnly(message, `(This message is ${sizeKb} KB, too large to show here. Download the original to read it.)`)
        : raw;

  // The original keeps the attachments; without it they are listed but cannot be downloaded.
  const id = crypto.randomUUID();
  let rawKey: string | null = null;
  if (raw) {
    try {
      await storeRawMail(env, rawMailKey(id), raw);
      rawKey = rawMailKey(id);
    } catch (err) {
      console.error("[Inbox] Storing the original of an incoming message failed:", err);
    }
  }
  const conversation = await fileIncomingMail(env, db, { id, from: message.from, to: message.to, parsable, rawKey });
  if (!conversation) {
    if (rawKey) await deleteRawMail(env, [rawKey]);
    return null;
  }

  if (env.SUPPORT_FORWARD_TO) {
    try {
      const headers = new Headers({ "X-LabKiosk-Reference": conversation.reference });
      await message.forward(env.SUPPORT_FORWARD_TO, headers);
    } catch (err) {
      // The message is filed; only the copy failed.
      console.error(`[Inbox] Forwarding ${conversation.reference} to the owner failed:`, err);
    }
  }
  return conversation;
}

/** What the controller did with a message the email Worker stored. */
export type IntakeResult = { status: "filed"; reference: string } | { status: "dropped" } | { status: "missing" };

/**
 * File a message the `labkiosk-email-routing` Worker already stored in R2
 * (`MailIntake.file` in src/index.ts, and the hourly sweep). Safe to repeat:
 * a message filed before answers with its conversation again.
 */
export async function fileStoredInboundMail(env: Env, db: D1Database, id: string, from: string, to: string): Promise<IntakeResult> {
  if (!isMailId(id)) throw new Error("Not a mail id");
  const envelopeFrom = String(from).trim().slice(0, 320);
  const envelopeTo = String(to).trim().slice(0, 320);
  if (!parseAddress(envelopeTo)) throw new Error("The recipient is not an email address");

  const filed = await db
    .prepare(
      "SELECT c.reference AS reference FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?"
    )
    .bind(id)
    .first<{ reference: string }>();
  if (filed) {
    await clearPendingMail(env, id);
    return { status: "filed", reference: filed.reference };
  }

  const key = rawMailKey(id);
  const raw = await loadRawMail(env, key);
  if (!raw) {
    // Nothing to file, now or later.
    console.error(`[Inbox] The original of incoming message ${id} is not in R2; it cannot be filed.`);
    await clearPendingMail(env, id);
    return { status: "missing" };
  }
  const sizeKb = Math.max(1, Math.round(raw.byteLength / 1024));
  const parsable =
    raw.byteLength > MAX_PARSED_BYTES
      ? headerSectionOnly(raw, `(This message is ${sizeKb} KB, too large to show here. Download the original to read it.)`)
      : raw;
  const conversation = await fileIncomingMail(env, db, { id, from: envelopeFrom, to: envelopeTo, parsable, rawKey: key });
  if (!conversation) await deleteRawMail(env, [key]);
  await clearPendingMail(env, id);
  return conversation ? { status: "filed", reference: conversation.reference } : { status: "dropped" };
}

/** Messages younger than this are left to the email Worker's own call. */
const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;
/** Messages the hourly sweep files at most. */
const SWEEP_LIMIT = 50;

/**
 * File what the email Worker stored but could not hand over (the controller
 * was down or failing). Returns how many were filed or dropped.
 */
export async function fileStrandedInboundMail(env: Env, db: D1Database, now = Date.now()): Promise<number> {
  let handled = 0;
  for (const pending of await listPendingMail(env, SWEEP_LIMIT)) {
    if (now - pending.storedAt < SWEEP_MIN_AGE_MS) continue;
    try {
      await fileStoredInboundMail(env, db, pending.id, pending.from, pending.to);
      handled++;
    } catch (err) {
      // Left pending: the next sweep tries again.
      console.error(`[Inbox] Filing stored message ${pending.id} failed:`, err);
    }
  }
  return handled;
}
