/**
 * Paying for a subscription online, with Razorpay Payment Links.
 *
 * Plan in the console asks for a link (POST /api/plan/checkout): the price is
 * worked out here (src/plans.ts quote), a payments row is written under our own
 * reference, and Razorpay is asked for a link that sends the payer back to
 * /api/billing/return. Two ways tell us it was paid, and either is enough:
 *  - the redirect back, whose razorpay_signature is the HMAC-SHA256, with the
 *    key secret, of "link id|reference id|status|payment id";
 *  - the payment_link.paid webhook, whose X-Razorpay-Signature is the
 *    HMAC-SHA256 of the raw body with the webhook secret.
 * Both mark the row paid at most once, and that one time extends the plan.
 *
 * Nothing here runs until RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set;
 * until then Plan offers to contact sales, and the platform records a
 * subscription by hand in Super Admin.
 */

import { timingSafeEqual } from "./auth";
import { findTenantById, updateTenant } from "./db";
import { entitlement, PRICING, type BillingPeriod, type Quote } from "./plans";
import type { Env } from "./types";

const RAZORPAY_ORIGIN = "https://api.razorpay.com";
/** How long a payment link stays open. */
const LINK_HOURS = 24;

export function billingEnabled(env: Env): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

export interface Payment {
  id: string;
  tenant_id: string;
  link_id: string | null;
  short_url: string | null;
  period: BillingPeriod;
  extra_workstations: number;
  subtotal_paise: number;
  gst_paise: number;
  total_paise: number;
  status: "created" | "paid";
  razorpay_payment_id: string | null;
  created_by: string | null;
  created_at: number;
  paid_at: number | null;
  period_ends_at: number | null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyReturnSignature(
  secret: string,
  p: { linkId: string; referenceId: string; status: string; paymentId: string; signature: string }
): Promise<boolean> {
  if (!p.signature) return false;
  const expected = await hmacHex(secret, `${p.linkId}|${p.referenceId}|${p.status}|${p.paymentId}`);
  return timingSafeEqual(expected, p.signature.toLowerCase());
}

export async function verifyWebhookSignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  return timingSafeEqual(await hmacHex(secret, body), signature.toLowerCase());
}

/** The end of a paid period that starts at `from`: one calendar month or one year later, UTC. */
export function periodEnd(from: number, period: BillingPeriod): number {
  const d = new Date(from * 1000);
  const months = period === "month" ? 1 : 12;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  // The same day of the month, or the month's last day when it has no such day.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return Math.floor(target.getTime() / 1000);
}

export function rupees(paise: number): string {
  const whole = Math.floor(paise / 100);
  const rest = paise % 100;
  return `₹${whole.toLocaleString("en-IN")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/**
 * Cloudflare answers 522, 525 and 526 itself when it could not connect, or
 * could not complete TLS, to the server behind the host: the request never
 * reached Razorpay's API, so it is safe to send once more.
 */
const NEVER_REACHED_ORIGIN = new Set([522, 525, 526]);

/**
 * Where a call to Razorpay goes: straight to Razorpay, or through the relay on
 * Google Cloud when RAZORPAY_RELAY_URL and RAZORPAY_RELAY_SECRET are set (see
 * relay/razorpay/handler.js for what the relay checks).
 */
export function razorpayRoute(env: Env): { kind: "direct" } | { kind: "relay"; url: string; secret: string } {
  const url = (env.RAZORPAY_RELAY_URL || "").trim().replace(/\/+$/, "");
  const secret = (env.RAZORPAY_RELAY_SECRET || "").trim();
  if (!url && !secret) return { kind: "direct" };
  if (!url || !secret) throw new Error("Set both RAZORPAY_RELAY_URL and RAZORPAY_RELAY_SECRET, or neither");
  if (!/^https:\/\/[^/?#]+(\/[^?#]*)?$/.test(url)) throw new Error("RAZORPAY_RELAY_URL must be an https address with no query");
  if (secret.length < 32) throw new Error("RAZORPAY_RELAY_SECRET must be at least 32 characters");
  return { kind: "relay", url, secret };
}

async function sendToRazorpay(env: Env, path: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<Response> {
  const route = razorpayRoute(env);
  if (route.kind === "direct") return fetch(`${RAZORPAY_ORIGIN}${path}`, init);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacHex(route.secret, `${timestamp}\n${init.method}\n${path}\n${init.body}`);
  return fetch(`${route.url}${path}`, {
    ...init,
    headers: { ...init.headers, "X-Relay-Timestamp": timestamp, "X-Relay-Signature": signature }
  });
}

async function fetchRazorpay(env: Env, path: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<Response> {
  const first = await sendToRazorpay(env, path, init);
  if (!NEVER_REACHED_ORIGIN.has(first.status)) return first;
  console.error(`[Billing] Razorpay ${path} answered ${describeHttpFailure(first)}; trying once more`);
  await first.body?.cancel();
  return sendToRazorpay(env, path, init);
}

/** "HTTP 525 (server cloudflare, ray abc123-MAA)": enough to tell whose edge answered, for Razorpay support. */
export function describeHttpFailure(res: Response): string {
  const details = [
    res.headers.get("server") ? `server ${res.headers.get("server")}` : "",
    res.headers.get("cf-ray") ? `ray ${res.headers.get("cf-ray")}` : ""
  ].filter(Boolean);
  return `HTTP ${res.status}${details.length ? ` (${details.join(", ")})` : ""}`;
}

/**
 * Ask Razorpay for a payment link for this quote. Throws when Razorpay does
 * not give one, with its own description of why.
 */
export async function createPaymentLink(
  env: Env,
  db: D1Database,
  input: { tenantId: string; organization: string; userId: string; email: string; name: string; quote: Quote; callbackUrl: string; nowSeconds: number }
): Promise<Payment> {
  if (!billingEnabled(env)) throw new Error("Online payment is not set up");
  // A half-set relay is a setup mistake: say so before anything is written.
  razorpayRoute(env);
  const id = `lk${crypto.randomUUID().replace(/-/g, "")}`;
  const q = input.quote;
  await db
    .prepare(
      `INSERT INTO payments (id, tenant_id, period, extra_workstations, subtotal_paise, gst_paise, total_paise, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`
    )
    .bind(id, input.tenantId, q.period, q.extraWorkstations, q.subtotal, q.gst, q.total, input.userId, input.nowSeconds)
    .run();
  const description =
    `Lab Kiosk subscription, ${q.period === "month" ? "1 month" : "1 year"}, ${q.workstations} workstations, for ${input.organization}`.slice(0, 2048);
  let res: Response;
  try {
    res = await fetchRazorpay(env, "/v1/payment_links", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: q.total,
        currency: PRICING.currency,
        reference_id: id,
        description,
        customer: { name: input.name.slice(0, 100), email: input.email },
        notify: { sms: false, email: false },
        reminder_enable: false,
        expire_by: input.nowSeconds + LINK_HOURS * 3600,
        callback_url: input.callbackUrl,
        callback_method: "get",
        notes: { tenant_id: input.tenantId, period: q.period, workstations: String(q.workstations) }
      })
    });
  } catch (err) {
    await db.prepare("DELETE FROM payments WHERE id = ? AND status = 'created'").bind(id).run();
    console.error("[Billing] Razorpay could not be reached:", err);
    throw new Error("Razorpay could not be reached. Try again in a few minutes.");
  }
  let data: { id?: unknown; short_url?: unknown; error?: { description?: unknown } } = {};
  try {
    data = await res.json();
  } catch (err) {
    console.error("[Billing] Razorpay answered with something that is not JSON:", err);
  }
  if (!res.ok || typeof data.id !== "string" || typeof data.short_url !== "string") {
    await db.prepare("DELETE FROM payments WHERE id = ? AND status = 'created'").bind(id).run();
    const why = typeof data.error?.description === "string" ? data.error.description : describeHttpFailure(res);
    throw new Error(`Razorpay did not create the payment link: ${why}`);
  }
  await db.prepare("UPDATE payments SET link_id = ?, short_url = ? WHERE id = ?").bind(data.id, data.short_url, id).run();
  return (await findPayment(db, id))!;
}

export async function findPayment(db: D1Database, id: string): Promise<Payment | null> {
  return db.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first<Payment>();
}

export async function listPayments(db: D1Database, tenantId: string): Promise<Payment[]> {
  const { results } = await db
    .prepare("SELECT * FROM payments WHERE tenant_id = ? AND status = 'paid' ORDER BY paid_at DESC, rowid DESC LIMIT 50")
    .bind(tenantId)
    .all<Payment>();
  return results ?? [];
}

/**
 * Record a payment and extend the subscription, once. A subscription still in
 * force is extended from its end; anything else starts now. Returns the
 * payment when this call recorded it, null when it was recorded already or is
 * not ours.
 */
export async function recordPayment(
  db: D1Database,
  ref: { referenceId: string; linkId: string; paymentId: string },
  nowSeconds: number
): Promise<Payment | null> {
  const payment = await findPayment(db, ref.referenceId);
  if (!payment || payment.link_id !== ref.linkId) return null;
  const claimed = await db
    .prepare("UPDATE payments SET status = 'paid', razorpay_payment_id = ?, paid_at = ? WHERE id = ? AND status = 'created'")
    .bind(ref.paymentId.slice(0, 64), nowSeconds, payment.id)
    .run();
  if (!claimed.meta.changes) return null;
  const tenant = await findTenantById(db, payment.tenant_id);
  if (!tenant) return null;
  const plan = entitlement(tenant, nowSeconds);
  const from = plan.kind === "subscription" && plan.expiresAt !== null && plan.expiresAt > nowSeconds ? plan.expiresAt : nowSeconds;
  const ends = periodEnd(from, payment.period);
  await updateTenant(db, tenant.id, {
    license_plan: "subscriber",
    license_expires_at: ends,
    workstation_limit: PRICING.includedWorkstations + Number(payment.extra_workstations)
  });
  await db.prepare("UPDATE payments SET period_ends_at = ? WHERE id = ?").bind(ends, payment.id).run();
  return (await findPayment(db, payment.id))!;
}

/** The parts of a payment_link.paid webhook this needs, or null for any other event. */
export function paidLinkFromWebhook(body: unknown): { referenceId: string; linkId: string; paymentId: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { event?: unknown; payload?: { payment_link?: { entity?: Record<string, unknown> }; payment?: { entity?: Record<string, unknown> } } };
  if (b.event !== "payment_link.paid") return null;
  const link = b.payload?.payment_link?.entity;
  const payment = b.payload?.payment?.entity;
  if (!link || typeof link.id !== "string" || typeof link.reference_id !== "string" || link.status !== "paid") return null;
  return { referenceId: link.reference_id, linkId: link.id, paymentId: typeof payment?.id === "string" ? payment.id : "" };
}
