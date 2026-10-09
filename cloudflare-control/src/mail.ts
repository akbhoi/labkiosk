/**
 * Outbound email.
 *
 * Every message the platform sends -- signup and sign-in codes, receipts,
 * approval decisions, replies and letters written in the Super Admin console --
 * goes through `sendMail()`. It decides who a message is from and where
 * answers go, then hands it to labkiosk-email-routing (the `MAILER` Service
 * Binding), which renders it with the shared templates and sends it. When that
 * Worker is not bound or does not answer, the message is rendered here with the
 * same templates and sent through this Worker's own `EMAIL` send_email binding,
 * so a sign-in code is never stranded by the other Worker.
 *
 * Nothing here pretends: without either binding and `MAIL_FROM` a production
 * Worker refuses (`mailConfigProblem()`), and a send that fails throws for the
 * caller to report.
 *
 * Tests and `ALLOW_LOCAL_DB=1` development send nothing unless MAIL_FROM is set:
 * messages land in an in-process outbox instead (`localOutbox()`), which is what
 * the tests read the signup codes from, and each subject is logged, which is
 * where a code is read under `pnpm dev`.
 */

import { Env } from "./types";
import { isLocalEnvironment } from "./database";
// The templates live with the Worker that sends; this is the same module it renders with.
import { Brand, MailTemplate, renderMailHtml } from "../../cloudflare-email-routing/src/templates";

export type { MailTemplate } from "../../cloudflare-email-routing/src/templates";

export interface OutgoingMail {
  to: string;
  toName?: string | null;
  subject: string;
  /** Plain text. It is the body of the HTML part too, so the two never disagree. */
  text: string;
  /** Which template the HTML part is built with; a plain notice when left out. */
  template?: MailTemplate;
  /** Set for an automatic answer, so the other side's own automation does not answer it back. */
  autoReply?: boolean;
  /** Message-ID of the message this answers, for threading in the customer's mail client. */
  inReplyTo?: string | null;
  references?: string[];
  /**
   * The platform address this is written as (`sales@labkiosk.org`). Mail goes out
   * from the same name on the sending domain, with this as Reply-To; without
   * one it is sent from MAIL_FROM with SUPPORT_ADDRESS as Reply-To.
   */
  mailbox?: string | null;
}

export interface LocalMail extends OutgoingMail {
  from: string;
  replyTo: string | null;
  messageId: string;
  /** The HTML part as it would have been sent. */
  html: string;
  headers: Record<string, string>;
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

/**
 * Local development and tests keep mail in the in-process outbox unless email
 * was set up on purpose. `wrangler dev` simulates the EMAIL binding and lists
 * the MAILER one unconnected, so the bindings alone say nothing: without
 * MAIL_FROM, a local Worker has not been given anywhere to send from.
 */
function usesLocalOutbox(env: Env): boolean {
  return isLocalEnvironment(env) && ((!env.EMAIL && !env.MAILER) || !parseAddress(env.MAIL_FROM || ""));
}

/** Why outbound email cannot work here, or null when it can. */
export function mailConfigProblem(env: Env): string | null {
  if (usesLocalOutbox(env)) return null;
  const missing: string[] = [];
  if (!env.EMAIL && !env.MAILER) missing.push("the MAILER service binding (or the EMAIL send_email binding)");
  if (!parseAddress(env.MAIL_FROM || "")) missing.push("the MAIL_FROM variable");
  if (!parseAddress(env.SUPPORT_ADDRESS || "")) missing.push("the SUPPORT_ADDRESS variable");
  return missing.length ? `Email is not configured on this server: ${missing.join(", ")} (docs/DEPLOYMENT.md, "Email").` : null;
}

/** `Name <address>` or a bare address; null when there is no usable address. */
export function parseAddress(value: string): { email: string; name: string } | null {
  const text = String(value || "").trim();
  if (!text || text.length > 400) return null;
  // Split by hand rather than with a backtracking pattern: part of this can come from a form.
  if (text.endsWith(">")) {
    const open = text.lastIndexOf("<");
    if (open < 0) return null;
    const email = text.slice(open + 1, -1);
    if (!isBareAddress(email)) return null;
    let name = text.slice(0, open).trim();
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    return { email: email.toLowerCase(), name };
  }
  return isBareAddress(text) ? { email: text.toLowerCase(), name: "" } : null;
}

/** `local@domain.tld`: one `@`, a dot in the domain, no spaces or angle brackets. */
function isBareAddress(value: string): boolean {
  if (/[\s<>]/.test(value)) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/** The address customers reply to; it routes back into the support inbox. */
export function supportAddress(env: Env): string | null {
  return parseAddress(env.SUPPORT_ADDRESS || "")?.email ?? null;
}

/** The address outbound mail is sent from. */
export function senderAddress(env: Env): string | null {
  return parseAddress(env.MAIL_FROM || "")?.email ?? null;
}

function domainOf(address: string | null): string | null {
  return address ? address.slice(address.indexOf("@") + 1) : null;
}

/**
 * The support address as a Mail tab mailbox. Local development without
 * SUPPORT_ADDRESS uses `support@` the default domain, so the tab still works.
 */
export function supportMailbox(env: Env): string | null {
  const configured = supportAddress(env);
  if (configured) return configured;
  return isLocalEnvironment(env) && env.DEFAULT_DOMAIN ? `support@${env.DEFAULT_DOMAIN.toLowerCase()}` : null;
}

/** The domain the Mail tab receives for: SUPPORT_ADDRESS's (`labkiosk.org`). */
export function mailDomain(env: Env): string | null {
  return domainOf(supportMailbox(env));
}

/** The domain outbound mail is sent from: MAIL_FROM's (`labkiosk.org`). */
export function sendingDomain(env: Env): string | null {
  return domainOf(senderAddress(env));
}

/** Who a message is from and where answers go, for a mailbox or the default. */
export function envelopeFor(env: Env, mailbox?: string | null): { from: { email: string; name: string }; replyTo: string | null } {
  const configured = parseAddress(env.MAIL_FROM || "") || { email: "noreply@outbox.local", name: "" };
  const name = configured.name || "Lab Kiosk";
  const box = mailbox ? parseAddress(mailbox)?.email ?? null : null;
  if (!box) return { from: { email: configured.email, name }, replyTo: supportAddress(env) };
  const local = box.slice(0, box.indexOf("@"));
  const domain = domainOf(configured.email)!;
  return { from: { email: domainOf(box) === domain ? box : `${local}@${domain}`, name }, replyTo: box };
}

/** Who a message says it is from, in its header and footer. */
function brandFor(env: Env, fromName: string, replyTo: string | null): Brand {
  return {
    name: fromName || "Lab Kiosk",
    siteUrl: env.DEFAULT_DOMAIN ? `https://${env.DEFAULT_DOMAIN.toLowerCase()}` : null,
    replyAddress: replyTo
  };
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
  if (mail.autoReply) {
    headers["Auto-Submitted"] = "auto-replied";
    headers["X-Auto-Response-Suppress"] = "All";
  }
  const template: MailTemplate = mail.template ?? { name: "notice" };
  const { from, replyTo } = envelopeFor(env, mail.mailbox);
  const brand = brandFor(env, from.name, replyTo);
  const html = () => renderMailHtml({ template, subject, text: mail.text, brand });

  if (usesLocalOutbox(env)) {
    const messageId = `<${crypto.randomUUID()}@outbox.local>`;
    localMail.push({
      ...mail,
      to: to.email,
      subject,
      from: `${from.name} <${from.email}>`,
      replyTo,
      messageId,
      html: html(),
      headers
    });
    if (localMail.length > LOCAL_OUTBOX_LIMIT) localMail.splice(0, localMail.length - LOCAL_OUTBOX_LIMIT);
    // Local development has no inbox to read: the log is where a registration code is found.
    console.log(`[Mail] Local outbox, not sent: to ${to.email}: ${subject}`);
    return { messageId };
  }

  const problem = mailConfigProblem(env);
  if (problem) throw new Error(problem);
  const toName = mail.toName ? headerSafe(mail.toName) : "";

  if (env.MAILER) {
    try {
      // The host is never resolved: a Service Binding goes straight to the Worker.
      const res = await env.MAILER.fetch("https://labkiosk-email-routing/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: { email: to.email, name: toName }, replyTo, subject, text: mail.text, template, brand, headers })
      });
      let data: { messageId?: unknown; error?: unknown } | null = null;
      try {
        data = await res.json<{ messageId?: unknown; error?: unknown }>();
      } catch {
        data = null;
      }
      if (res.ok && typeof data?.messageId === "string") return { messageId: data.messageId };
      throw new Error(typeof data?.error === "string" ? data.error : `The email Worker answered ${res.status}`);
    } catch (err) {
      if (!env.EMAIL) throw err;
      console.error("[Mail] labkiosk-email-routing did not send the message; sending it directly:", err);
    }
  }

  const result = await env.EMAIL!.send({
    from,
    to: toName ? { email: to.email, name: toName } : to.email,
    replyTo: replyTo!,
    subject,
    text: mail.text,
    html: html(),
    headers
  });
  return { messageId: result.messageId };
}
