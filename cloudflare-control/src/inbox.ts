/**
 * The Super Admin console's Tasks and Mail, and the email they run on.
 *
 * - `/api/super/inbox...` (super admin only): list (by mailbox), read, reply,
 *   write a new email, add a note, approve or reject a task, mark a signup's
 *   phone as verified, close, reopen or delete a mail conversation, and
 *   download an inbound message's attachments or original. Every reply goes
 *   out as email from here.
 * - `handleInboundEmail()`: the Worker's `email()` handler. Mail routed to the
 *   Worker (every address on the mail domain, through the catch-all) is kept
 *   whole in R2 and filed into its conversation by the `[LK-XXXXXX]` reference
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
  Conversation,
  ConversationKind,
  createConversation,
  deleteConversation,
  findConversation,
  findConversationMessage,
  findConversationByEmailMessageIds,
  findConversationByReference,
  findOrganizationProfile,
  inboxCounts,
  listConversationMessages,
  listConversations,
  mailboxCounts,
  markConversationRead,
  markPhoneVerified,
  MAX_MESSAGE_CHARS,
  referenceInSubject,
  setConversationStatus,
  TASK_KINDS
} from "./conversations";
import { mailConfigProblem, mailDomain, parseAddress, sendingDomain } from "./mail";
import { deleteRawMail, loadRawMail, rawMailKey, storeRawMail } from "./mail_store";
import { extractAttachment, parseEmail } from "./mime";
import { consoleUrlFor, RouteContext, sendOnConversation } from "./signup";

const SUPPORT_KINDS: readonly ConversationKind[] = ["support"];
const INBOX_PATH =
  /^\/api\/super\/inbox(?:\/compose|\/([0-9a-f-]{36})(?:\/(reply|note|approve|reject|verify-phone|status|delete)|\/attachment\/([0-9a-f-]{36})\/(original|\d{1,2}))?)?$/;
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

/** POST /api/super/inbox/compose: start a conversation with an email written as one of the platform's addresses. */
async function handleCompose(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, request, session } = ctx;
  const problem = mailConfigProblem(env);
  if (problem) return jsonError(problem, 503, jsonHeaders);
  const domain = mailDomain(env);
  if (!domain) return jsonError("Set SUPPORT_ADDRESS to say which domain the mailboxes are on", 503, jsonHeaders);
  let body: { from?: unknown; to?: unknown; subject?: unknown; message?: unknown };
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

  const userId = session!.user_id;
  const conversation = await createConversation(db, {
    kind: "support",
    tenantId: null,
    subject,
    contactEmail: to.email,
    contactName: to.name || null,
    mailbox: `${fromLocal}@${domain}`,
    unread: false
  });
  const sent = await sendOnConversation(env, db, conversation, message, { authorUserId: userId });
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

  // GET /api/super/inbox?box=tasks|support&filter=open|closed|all&mailbox=<address>
  if (!id) {
    if (method !== "GET") return jsonError("Method not allowed", 405, jsonHeaders);
    const box = url.searchParams.get("box") === "support" ? "support" : "tasks";
    const filterParam = url.searchParams.get("filter");
    const filter = filterParam === "closed" || filterParam === "all" ? filterParam : "open";
    const mailbox = box === "support" ? (parseAddress(url.searchParams.get("mailbox") || "")?.email ?? null) : null;
    const items = await listConversations(db, box === "support" ? SUPPORT_KINDS : TASK_KINDS, filter, 200, mailbox);
    return json(
      {
        box,
        filter,
        mailbox,
        items,
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

  // POST .../delete: a mail conversation, its messages and their stored originals.
  if (action === "delete") {
    if (method !== "POST") return jsonError("Method not allowed", 405, jsonHeaders);
    if (conversation.kind !== "support") return jsonError("Tasks stay on record and cannot be deleted", 400, jsonHeaders);
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
      { subject: "Your organization is active", authorUserId: userId, ...threading }
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
      { subject: "About your registration", authorUserId: userId, ...threading }
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
      { subject: approve ? "Remote Control is on" : "About your Remote Control request", authorUserId: userId, ...threading }
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

/**
 * File one incoming email. Returns the conversation it went to, or null when
 * it was dropped (a message from the platform's own sending address: a loop).
 */
export async function handleInboundEmail(message: InboundMessage, env: Env, db: D1Database): Promise<Conversation | null> {
  const raw = await readRaw(message);
  const sizeKb = Math.max(1, Math.round(message.rawSize / 1024));
  const parsed = parseEmail(
    raw === null
      ? headersOnly(message, `(This message was ${sizeKb} KB, too large to receive here.)`)
      : raw.byteLength > MAX_PARSED_BYTES
        ? headersOnly(message, `(This message is ${sizeKb} KB, too large to show here. Download the original to read it.)`)
        : raw
  );
  // Who wrote it (the From header, else the envelope) decides which thread it may join;
  // Reply-To, which anyone can set, only decides where answers go.
  const author = parsed.from || { address: message.from.toLowerCase(), name: "" };
  const sender = parsed.replyTo || author;
  // Everything the platform sends is from the sending domain: mail from it is a loop.
  const own = sendingDomain(env);
  if (own && (domainOf(author.address) === own || domainOf(message.from) === own)) {
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

  if (!conversation) {
    conversation = await createConversation(db, {
      kind: "support",
      tenantId: null,
      subject: parsed.subject || "(no subject)",
      contactEmail: sender.address,
      contactName: sender.name || null,
      mailbox: parseAddress(message.to)?.email ?? null
    });
  } else if (conversation.kind === "support" && conversation.status === "closed" && !parsed.automated) {
    // The customer wrote again: the conversation needs attention again.
    await setConversationStatus(db, conversation.id, "open", null);
  }

  // The original keeps the attachments; without it they are listed but cannot be downloaded.
  const messageId = crypto.randomUUID();
  let rawKey: string | null = null;
  if (raw) {
    try {
      await storeRawMail(env, rawMailKey(messageId), raw);
      rawKey = rawMailKey(messageId);
    } catch (err) {
      console.error(`[Inbox] Storing the original of a message on ${conversation.reference} failed:`, err);
    }
  }
  const attachments: AttachmentInfo[] = parsed.attachments.map((a) => ({
    index: a.index,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size
  }));
  await addConversationMessage(db, {
    id: messageId,
    conversationId: conversation.id,
    direction: "inbound",
    body: (parsed.text || "(no text)") + (parsed.automated ? "\n\n[Automatic message]" : ""),
    fromAddress: sender.address,
    toAddress: message.to.toLowerCase(),
    subject: parsed.subject,
    emailMessageId: parsed.messageId,
    rawKey,
    attachments
  });

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
