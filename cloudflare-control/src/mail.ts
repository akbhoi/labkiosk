/**
 * Outbound email through Cloudflare Email Service (the `EMAIL` send_email binding).
 *
 * Every message the platform sends -- signup codes, approval decisions, replies
 * written in the Super Admin console -- goes through `sendMail()`. Nothing here
 * pretends: without the binding and `MAIL_FROM` a production Worker refuses
 * (`mailConfigProblem()`), and a send that fails throws for the caller to report.
 *
 * Tests and `ALLOW_LOCAL_DB=1` development have no binding: messages land in an
 * in-process outbox instead (`localOutbox()`), which is what the tests read the
 * signup codes from.
 */

import { Env } from "./types";
import { isLocalEnvironment } from "./database";
import { escapeHtml } from "./escape";

export interface OutgoingMail {
  to: string;
  toName?: string | null;
  subject: string;
  /** Plain text. The HTML part is derived from it, so the two never disagree. */
  text: string;
  /** Message-ID of the message this answers, for threading in the customer's mail client. */
  inReplyTo?: string | null;
  references?: string[];
}

export interface LocalMail extends OutgoingMail {
  from: string;
  replyTo: string | null;
  messageId: string;
}

export interface SentMail {
  messageId: string;
}

const localMail: LocalMail[] = [];
/** Messages the local outbox keeps; the oldest are dropped past this. */
const LOCAL_OUTBOX_LIMIT = 500;

/** Messages "sent" without a binding (tests and local development only), oldest first. */
export function localOutbox(): readonly LocalMail[] {
  return localMail;
}

/** Why outbound email cannot work here, or null when it can. */
export function mailConfigProblem(env: Env): string | null {
  if (!env.EMAIL && isLocalEnvironment(env)) return null;
  const missing: string[] = [];
  if (!env.EMAIL) missing.push("the EMAIL send_email binding");
  if (!parseAddress(env.MAIL_FROM || "")) missing.push("the MAIL_FROM variable");
  if (!parseAddress(env.SUPPORT_ADDRESS || "")) missing.push("the SUPPORT_ADDRESS variable");
  return missing.length ? `Email is not configured on this server: ${missing.join(", ")} (docs/DEPLOYMENT.md, "Email").` : null;
}

/** `Name <address>` or a bare address; null when there is no usable address. */
export function parseAddress(value: string): { email: string; name: string } | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const angled = text.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, "$1");
    return { email: angled[2].toLowerCase(), name };
  }
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text) ? { email: text.toLowerCase(), name: "" } : null;
}

/** The address customers reply to; it routes back into the support inbox. */
export function supportAddress(env: Env): string | null {
  return parseAddress(env.SUPPORT_ADDRESS || "")?.email ?? null;
}

/** The address outbound mail is sent from. */
export function senderAddress(env: Env): string | null {
  return parseAddress(env.MAIL_FROM || "")?.email ?? null;
}

/** Plain text as a minimal HTML body: escaped, paragraphs and line breaks kept. */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">${paragraphs}</body></html>`;
}

/** A header value may not carry a line break: it would start a new header. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Send one message. Throws when it was not accepted, so the caller can say so
 * and record the failure; returns the provider's message id when it was.
 */
export async function sendMail(env: Env, mail: OutgoingMail): Promise<SentMail> {
  const to = parseAddress(mail.to);
  if (!to) throw new Error("The recipient address is not valid");
  const subject = headerSafe(mail.subject).slice(0, 250);
  const headers: Record<string, string> = {};
  if (mail.inReplyTo) headers["In-Reply-To"] = headerSafe(mail.inReplyTo);
  const references = (mail.references || []).map(headerSafe).filter(Boolean);
  if (references.length) headers["References"] = references.slice(-20).join(" ");

  if (!env.EMAIL) {
    if (!isLocalEnvironment(env)) throw new Error(mailConfigProblem(env) || "Email is not configured");
    const messageId = `<${crypto.randomUUID()}@outbox.local>`;
    localMail.push({
      ...mail,
      to: to.email,
      subject,
      from: env.MAIL_FROM || "Lab Kiosk <noreply@outbox.local>",
      replyTo: env.SUPPORT_ADDRESS || null,
      messageId
    });
    if (localMail.length > LOCAL_OUTBOX_LIMIT) localMail.splice(0, localMail.length - LOCAL_OUTBOX_LIMIT);
    // Local development has no inbox to read: the log is where a registration code is found.
    console.log(`[Mail] Local outbox, not sent: to ${to.email}: ${subject}`);
    return { messageId };
  }

  const problem = mailConfigProblem(env);
  if (problem) throw new Error(problem);
  const from = parseAddress(env.MAIL_FROM!)!;
  const replyTo = parseAddress(env.SUPPORT_ADDRESS!)!;
  const result = await env.EMAIL.send({
    from: { email: from.email, name: from.name || "Lab Kiosk" },
    to: mail.toName ? { email: to.email, name: headerSafe(mail.toName) } : to.email,
    replyTo: replyTo.email,
    subject,
    text: mail.text,
    html: textToHtml(mail.text),
    headers
  });
  return { messageId: result.messageId };
}
