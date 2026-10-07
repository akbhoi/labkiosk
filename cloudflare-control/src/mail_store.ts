/**
 * The original of every email the Mail tab receives, kept in R2 under `mail/`.
 *
 * D1 holds the readable text and the attachment list; the original (with the
 * attachment bytes) lives in the `AUDIT_ARCHIVE` bucket, which production
 * already requires (`requiredBindingsProblem()`). Tests and `ALLOW_LOCAL_DB=1`
 * development without the binding use an in-process map instead.
 */

import { Env } from "./types";
import { isLocalEnvironment } from "./database";

const PREFIX = "mail/";
const localStore = new Map<string, Uint8Array>();
/** Originals the local stand-in keeps; the oldest are dropped past this. */
const LOCAL_STORE_LIMIT = 200;

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
