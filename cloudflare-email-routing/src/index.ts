/**
 * labkiosk-email-routing: the Email Routing destination Worker for every
 * address on the platform's domain (the catch-all).
 *
 * It does as little as possible, so that mail keeps arriving whatever state
 * the controller is in:
 *   1. keep the original in R2 (`mail/<id>.eml`) with a marker
 *      (`mail-pending/<id>`) that carries the envelope;
 *   2. hand the message to labkiosk-controller's `MailIntake` entrypoint over
 *      a Service Binding, which files it into the Super Admin console's Mail
 *      and removes the marker;
 *   3. forward the owner a copy when SUPPORT_FORWARD_TO is set.
 * When step 2 fails, the marker stays and the controller's hourly sweep files
 * the message later. Parsing, threading and the database belong to the
 * controller alone (cloudflare-control/src/inbox.ts).
 */

/** What the controller did with a message (cloudflare-control/src/inbox.ts, `IntakeResult`). */
export type IntakeResult = { status: "filed"; reference: string } | { status: "dropped" } | { status: "missing" };

/** labkiosk-controller's `MailIntake` entrypoint, as the Service Binding exposes it. */
export interface MailIntake {
  file(id: string, from: string, to: string): Promise<IntakeResult>;
}

export interface Env {
  MAIL_ARCHIVE: R2Bucket;
  CONTROLLER: MailIntake;
  SUPPORT_FORWARD_TO?: string;
}

/** The parts of `ForwardableEmailMessage` the handler uses (tests pass a stand-in). */
export interface InboundMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

/** Email Routing's own limit: nothing larger should arrive. */
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

export function rawKey(id: string): string {
  return `mail/${id}.eml`;
}

export function pendingKey(id: string): string {
  return `mail-pending/${id}`;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Store the original and its marker. Returns false when either write failed. */
async function store(env: Env, id: string, message: InboundMessage, raw: Uint8Array): Promise<boolean> {
  try {
    await env.MAIL_ARCHIVE.put(rawKey(id), raw, { httpMetadata: { contentType: "message/rfc822" } });
  } catch (err) {
    console.error("[Email] Storing an incoming message in R2 failed:", err);
    return false;
  }
  try {
    await env.MAIL_ARCHIVE.put(pendingKey(id), new Uint8Array(0), { customMetadata: { from: message.from, to: message.to } });
    return true;
  } catch (err) {
    console.error(`[Email] Marking incoming message ${id} as pending failed:`, err);
  }
  // Without its marker nothing would ever file the original: take it back out.
  try {
    await env.MAIL_ARCHIVE.delete(rawKey(id));
  } catch (err) {
    console.error(`[Email] Removing the unmarked original of ${id} failed:`, err);
  }
  return false;
}

export async function handleEmail(message: InboundMessage, env: Env): Promise<void> {
  const forwardTo = (env.SUPPORT_FORWARD_TO || "").trim();
  if (message.rawSize > MAX_INBOUND_BYTES) {
    await message.raw.cancel();
    message.setReject("Message too large");
    return;
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const id = crypto.randomUUID();

  if (!(await store(env, id, message, raw))) {
    // Not kept anywhere: the owner's copy is the only one left, and without it
    // the sender is better off with a bounce than with silence.
    if (!forwardTo) throw new Error("The incoming message could not be stored and no SUPPORT_FORWARD_TO is set.");
    await message.forward(forwardTo);
    return;
  }

  let result: IntakeResult | null = null;
  try {
    result = await env.CONTROLLER.file(id, message.from, message.to);
  } catch (err) {
    console.error(`[Email] The controller could not file ${id}; its hourly sweep will:`, err);
  }

  if (!forwardTo) return;
  // A message from the platform's own domain is a loop: the controller says
  // so, and without its answer the envelope is the best guess.
  if (result?.status === "dropped") return;
  if (result === null && domainOf(message.from) === domainOf(message.to)) return;
  const headers = new Headers();
  if (result?.status === "filed") headers.set("X-LabKiosk-Reference", result.reference);
  try {
    await message.forward(forwardTo, headers);
  } catch (err) {
    // The message is kept; only the copy failed.
    console.error(`[Email] Forwarding ${id} to the owner failed:`, err);
  }
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  }
} satisfies ExportedHandler<Env>;
