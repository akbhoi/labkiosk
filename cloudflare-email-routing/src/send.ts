/**
 * Outbound mail: labkiosk-controller hands a message here over its `MAILER`
 * Service Binding (`POST /send`), and this Worker renders it with the shared
 * templates and sends it through its own `EMAIL` send_email binding.
 *
 * The Worker has no route and no workers.dev address, so only a Service
 * Binding can reach this. The controller decides who a message is from and
 * who it goes to; this side checks the shape of what it was handed, refuses
 * anything that could start a new header, and never builds a message from
 * unescaped input (`src/templates/`).
 */

import { Brand, MailTemplate, renderMailHtml, TEMPLATE_NAMES } from "./templates";
import { isPlainAddress } from "./templates/layout";

export interface SendRequest {
  from: { email: string; name: string };
  to: { email: string; name?: string | null };
  replyTo: string;
  subject: string;
  /** The plain-text part. */
  text: string;
  template: MailTemplate;
  brand: Brand;
  /** Threading and auto-reply headers; anything else is refused. */
  headers?: Record<string, string>;
}

export interface MailerEnv {
  EMAIL?: SendEmail;
}

const ALLOWED_HEADERS = new Set(["in-reply-to", "references", "auto-submitted", "x-auto-response-suppress"]);
const MAX_TEXT_CHARS = 100_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** One address, with a dot in its domain, and nothing that could make it a list of them. */
function isAddress(value: unknown): value is string {
  if (typeof value !== "string" || !isPlainAddress(value) || value.includes(",") || value.includes(";")) return false;
  const domain = value.slice(value.indexOf("@") + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/** One line: a line break in a header value would start a new header. */
function oneLine(value: unknown): value is string {
  return typeof value === "string" && !/[\r\n]/.test(value);
}

/** Why a request cannot be sent, or null. */
export function sendRequestProblem(body: unknown): string | null {
  const mail = body as Partial<SendRequest> | null;
  if (!mail || typeof mail !== "object") return "The request body must be a JSON object";
  if (!mail.from || !isAddress(mail.from.email) || !oneLine(mail.from.name ?? "")) return "from is not a usable sender";
  if (!mail.to || !isAddress(mail.to.email) || !oneLine(mail.to.name ?? "")) return "to is not a usable recipient";
  if (!isAddress(mail.replyTo)) return "replyTo is not an address";
  if (!oneLine(mail.subject) || !mail.subject.trim() || mail.subject.length > 250) return "subject must be one line of at most 250 characters";
  if (typeof mail.text !== "string" || !mail.text.trim() || mail.text.length > MAX_TEXT_CHARS) return "text is missing or too long";
  const name = (mail.template as { name?: unknown } | undefined)?.name;
  if (typeof name !== "string" || !(TEMPLATE_NAMES as readonly string[]).includes(name)) return "template is not one this Worker has";
  if (!mail.brand || typeof mail.brand.name !== "string" || !mail.brand.name.trim()) return "brand is missing";
  for (const [header, value] of Object.entries(mail.headers || {})) {
    if (!ALLOWED_HEADERS.has(header.toLowerCase())) return `the ${header} header may not be set`;
    if (!oneLine(value) || value.length > 4000) return `the ${header} header is not one line`;
  }
  return null;
}

/** `POST /send`: render and send one message. Answers `{ messageId }`, or `{ error }` with why not. */
export async function handleSend(request: Request, env: MailerEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.EMAIL) return json({ error: "The EMAIL send_email binding is not set on labkiosk-email-routing" }, 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The request body must be JSON" }, 400);
  }
  const problem = sendRequestProblem(body);
  if (problem) return json({ error: problem }, 400);
  const mail = body as SendRequest;

  let html: string;
  try {
    html = renderMailHtml({ template: mail.template, subject: mail.subject, text: mail.text, brand: mail.brand });
  } catch (err) {
    console.error("[Email] Rendering a message failed:", err);
    return json({ error: "The message could not be rendered from its template" }, 400);
  }
  try {
    const result = await env.EMAIL.send({
      from: { email: mail.from.email, name: mail.from.name },
      to: mail.to.name ? { email: mail.to.email, name: mail.to.name } : mail.to.email,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html,
      headers: mail.headers || {}
    });
    return json({ messageId: result.messageId });
  } catch (err) {
    console.error("[Email] Sending a message failed:", err);
    return json({ error: err instanceof Error ? err.message : "The message was not accepted" }, 502);
  }
}
