/**
 * A one-time emailed link that asks an organization to verify its phone number
 * by text message, for registrations made before numbers were checked that way.
 *
 * A super admin sends it from the registration's task in the inbox (src/inbox.ts,
 * `phone-link`). The link opens `/verify-phone`, where the owner has Firebase text
 * the number on record and enters the code (src/ui_verify_phone.ts); the page
 * posts the resulting ID token to `POST /api/verify-phone`, which checks it like
 * registration does (src/phone_verify.ts) and records the number as verified.
 *
 * Only the SHA-256 of the link's token is stored. A new link replaces the old one,
 * and the link stops working once the number is verified or after PHONE_LINK_DAYS.
 */

import { sha256Hex } from "./auth";
import { addConversationMessage, OrganizationProfile } from "./conversations";
import { findTenantById, writeAuditLog } from "./db";
import { jsonError } from "./guard";
import { firebaseConfig, firebaseConfigProblem, phoneTokenMessage, verifyPhoneToken } from "./phone_verify";
import type { RouteContext } from "./signup";

export const PHONE_LINK_DAYS = 7;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function linkHash(token: string): Promise<string> {
  return sha256Hex(`phone-link:${token}`);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Create a new link token for the organization, replacing any earlier one. Returns the token. */
export async function issuePhoneLink(db: D1Database, tenantId: string): Promise<{ token: string; expiresAt: number }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = nowSeconds() + PHONE_LINK_DAYS * 24 * 3600;
  const res = await db
    .prepare("UPDATE organization_profiles SET phone_link_hash = ?, phone_link_expires_at = ?, updated_at = ? WHERE tenant_id = ?")
    .bind(await linkHash(token), expiresAt, nowSeconds(), tenantId)
    .run();
  if (!res.meta.changes) throw new Error(`Organization ${tenantId} has no profile to send a phone link for`);
  return { token, expiresAt };
}

/** The profile a link token belongs to, while the link still works. */
export async function findPhoneLink(db: D1Database, token: unknown): Promise<OrganizationProfile | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  return db
    .prepare(
      "SELECT * FROM organization_profiles WHERE phone_link_hash = ? AND phone_link_expires_at > ? AND phone_verified_at IS NULL"
    )
    .bind(await linkHash(token), nowSeconds())
    .first<OrganizationProfile>();
}

/**
 * Record the number as verified by text message (phone_verified_by stays empty,
 * which the inbox shows as "verified by SMS") and spend the link. False when the
 * link was spent or replaced meanwhile.
 */
export async function completePhoneLink(db: D1Database, token: string, tenantId: string): Promise<boolean> {
  const ts = nowSeconds();
  const res = await db
    .prepare(
      "UPDATE organization_profiles SET phone_verified_at = ?, phone_verified_by = NULL, phone_link_hash = NULL, phone_link_expires_at = NULL, updated_at = ? " +
        "WHERE tenant_id = ? AND phone_link_hash = ? AND phone_verified_at IS NULL"
    )
    .bind(ts, ts, tenantId, await linkHash(token))
    .run();
  return Boolean(res.meta.changes);
}

/** A phone number with all but its last four digits hidden: "+91 •••••• 3210". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "••••";
  return `${phone.trim().startsWith("+") ? "+" : ""}${"•".repeat(Math.min(digits.length - 4, 10))} ${digits.slice(-4)}`;
}

/** POST /api/verify-phone { token, phoneToken }: the page's last step. */
export async function handleVerifyPhone(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, request } = ctx;
  let body: { token?: unknown; phoneToken?: unknown };
  try {
    body = await request.json<{ token?: unknown; phoneToken?: unknown }>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const firebase = firebaseConfigProblem(env) ? null : firebaseConfig(env);
  if (!firebase) return jsonError("Phone verification by text message is not set up on this platform.", 503, jsonHeaders);
  const profile = await findPhoneLink(db, body.token);
  if (!profile) return jsonError("This link has expired or was already used. Reply to our email for a new one.", 410, jsonHeaders);
  const checked = await verifyPhoneToken(firebase, body.phoneToken, profile.contact_phone);
  if (!checked.ok) {
    if (checked.reason === "unavailable") console.error("[Phone] Google's keys could not be fetched:", checked.detail);
    const { message, status } = phoneTokenMessage(checked);
    return jsonError(message, status, jsonHeaders);
  }
  if (!(await completePhoneLink(db, body.token as string, profile.tenant_id))) {
    return jsonError("This link has expired or was already used. Reply to our email for a new one.", 410, jsonHeaders);
  }
  const conversation = await db
    .prepare("SELECT id FROM conversations WHERE tenant_id = ? AND kind = 'signup' ORDER BY created_at DESC LIMIT 1")
    .bind(profile.tenant_id)
    .first<{ id: string }>();
  if (conversation) {
    await addConversationMessage(db, {
      conversationId: conversation.id,
      direction: "event",
      body: `Phone number ${profile.contact_phone} verified by text message from the emailed link.`
    });
  }
  const tenant = await findTenantById(db, profile.tenant_id);
  await writeAuditLog(db, { tenantId: profile.tenant_id, userId: tenant?.user_id ?? null, action: "tenant.verify_phone_sms" });
  return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
}
