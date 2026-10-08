/**
 * The original of every email the Mail tab receives, kept in R2 under `mail/`.
 *
 * D1 holds the readable text and the attachment list; the original (with the
 * attachment bytes) lives in the `AUDIT_ARCHIVE` bucket, which production
 * already requires (`requiredBindingsProblem()`). Tests and `ALLOW_LOCAL_DB=1`
 * development without the binding use an in-process map instead.
 *
 * Mail arriving through the separate `labkiosk-email-routing` Worker
 * (cloudflare-email-routing/) is written here by that Worker first: the
 * original under `mail/<id>.eml` and an empty marker under
 * `mail-pending/<id>` carrying the envelope. The controller files it
 * (`MailIntake` in src/index.ts) and removes the marker; a marker left behind
 * is filed by the hourly sweep, so a message survives a broken deploy.
 */

import { Env } from "./types";
import { isLocalEnvironment } from "./database";

const PREFIX = "mail/";
const PENDING_PREFIX = "mail-pending/";
const MAIL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const localStore = new Map<string, Uint8Array>();
const localPending = new Map<string, PendingMail>();
/** Originals the local stand-in keeps; the oldest are dropped past this. */
const LOCAL_STORE_LIMIT = 200;

/** A message the email Worker stored and the controller has not filed yet. */
export interface PendingMail {
  id: string;
  from: string;
  to: string;
  /** When the email Worker stored it, in milliseconds. */
  storedAt: number;
}

/** Whether `id` is the shape of id the email Worker gives a message (a lowercase UUID). */
export function isMailId(id: unknown): id is string {
  return typeof id === "string" && MAIL_ID.test(id);
}

/** The key an inbound message's original is stored under. */
export function rawMailKey(messageId: string): string {
  return `${PREFIX}${messageId}.eml`;
}

function bucket(env: Env): R2Bucket | null {
  if (env.AUDIT_ARCHIVE) return env.AUDIT_ARCHIVE;
  if (isLocalEnvironment(env)) return null;
  throw new Error("The AUDIT_ARCHIVE R2 bucket is not bound; incoming mail cannot be stored.");
}

export async function storeRawMail(env: Env, key: string, bytes: Uint8Array): Promise<void> {
  if (!key.startsWith(PREFIX)) throw new Error("Not a mail key");
  const store = bucket(env);
  if (!store) {
    localStore.set(key, bytes);
    if (localStore.size > LOCAL_STORE_LIMIT) localStore.delete(localStore.keys().next().value as string);
    return;
  }
  await store.put(key, bytes, { httpMetadata: { contentType: "message/rfc822" } });
}

/** The stored original, or null when it is gone. */
export async function loadRawMail(env: Env, key: string): Promise<Uint8Array | null> {
  if (!key.startsWith(PREFIX)) return null;
  const store = bucket(env);
  if (!store) return localStore.get(key) ?? null;
  const object = await store.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

export async function deleteRawMail(env: Env, keys: readonly string[]): Promise<void> {
  const own = keys.filter((key) => key.startsWith(PREFIX));
  if (!own.length) return;
  const store = bucket(env);
  if (!store) {
    for (const key of own) localStore.delete(key);
    return;
  }
  // R2 deletes up to 1000 keys per call.
  for (let i = 0; i < own.length; i += 1000) await store.delete(own.slice(i, i + 1000));
}

function pendingKey(id: string): string {
  if (!isMailId(id)) throw new Error("Not a mail id");
  return `${PENDING_PREFIX}${id}`;
}

/**
 * Mark a stored message as waiting to be filed. The email Worker does this in
 * production; the controller only calls it from tests and local development.
 */
export async function markPendingMail(env: Env, mail: PendingMail): Promise<void> {
  const key = pendingKey(mail.id);
  const store = bucket(env);
  if (!store) {
    localPending.set(mail.id, { ...mail });
    return;
  }
  await store.put(key, new Uint8Array(0), { customMetadata: { from: mail.from, to: mail.to } });
}

/** Up to `limit` messages still waiting to be filed, oldest key order. */
export async function listPendingMail(env: Env, limit: number): Promise<PendingMail[]> {
  const store = bucket(env);
  if (!store) return [...localPending.values()].slice(0, limit);
  const listed = await store.list({ prefix: PENDING_PREFIX, limit, include: ["customMetadata"] });
  const pending: PendingMail[] = [];
  for (const object of listed.objects) {
    const id = object.key.slice(PENDING_PREFIX.length);
    if (!isMailId(id)) {
      console.warn(`[Mail] Ignoring an unexpected key under ${PENDING_PREFIX}: ${object.key}`);
      continue;
    }
    pending.push({
      id,
      from: object.customMetadata?.from ?? "",
      to: object.customMetadata?.to ?? "",
      storedAt: object.uploaded.getTime()
    });
  }
  return pending;
}

export async function clearPendingMail(env: Env, id: string): Promise<void> {
  const key = pendingKey(id);
  const store = bucket(env);
  if (!store) {
    localPending.delete(id);
    return;
  }
  await store.delete(key);
}
