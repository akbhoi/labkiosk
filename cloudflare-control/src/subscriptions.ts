/**
 * Subscriptions that renew by themselves, through Razorpay Subscriptions.
 *
 * Lab Kiosk writes a subscriptions row with the price worked out here
 * (src/plans.ts quoteTier), then asks Razorpay for a plan of exactly that
 * amount and a subscription on it, whose short_url the payer opens to
 * authorise the mandate. From then on Razorpay charges each period.
 *
 * What Razorpay says is never taken from a webhook body: every event, the
 * hourly cron and a payer's return only prompt syncSubscription(), which
 * fetches the subscription and its invoices from Razorpay's API and applies
 * them. Applying is idempotent (a payment id is invoiced and granted once,
 * end dates only move forward), so events may come late, twice or out of
 * order.
 *
 * Changes: Razorpay cannot update a subscription paid by UPI Autopay or
 * e-mandate, so any change is a replacement subscription that starts when the
 * current one's paid period ends. An increase charges the pro-rated
 * difference once, as an upfront add-on when the replacement is authorised,
 * and applies at once. The subscription it replaces is cancelled only after
 * the replacement is authorised; until then it keeps renewing as it was.
 *
 * Cancelling cancels at Razorpay at once, so no further charge can happen;
 * the organization keeps what it paid for until current_end. Resuming is a
 * new authorisation that starts then.
 */

import { razorpayJson, RazorpayError } from "./billing";
import { findTenantById, writeAuditLog } from "./db";
import { gstPercentFor, invoiceStatements, type InvoiceLine } from "./invoices";
import { createNotification } from "./notifications";
import { CATALOGUE, PRICING, prorate, quoteTier, type BillingPeriod, type SoldTier, type TierQuote, type TierQuoteInput } from "./plans";
import type { Env, Tenant } from "./types";

const DAY = 86_400;
/** How long a halted subscription's organization keeps its plan. */
export const GRACE_DAYS = 7;
/** How long a checkout waits to be authorised. */
const CHECKOUT_HOURS = 24;
/** Razorpay needs a number of charges: ten years either way. */
const TOTAL_COUNT: Record<BillingPeriod, number> = { month: 120, year: 10 };
/** A start closer than this is "now" to Razorpay. */
const MIN_START_LEAD = 300;

export type SubscriptionStatus = "created" | "authenticated" | "active" | "pending" | "halted" | "cancelled" | "completed" | "paused" | "expired";

const STATUSES: readonly SubscriptionStatus[] = ["created", "authenticated", "active", "pending", "halted", "cancelled", "completed", "paused", "expired"];
/** Razorpay will charge nothing more on a subscription in one of these. */
const FINAL: ReadonlySet<SubscriptionStatus> = new Set(["cancelled", "completed", "expired"]);

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  tier: SoldTier;
  period: BillingPeriod;
  catalogue_version: number;
  extra_workstations: number;
  remote_seats: number;
  /** 1 when it sells the custom domain add-on (0064). */
  custom_domain: number;
  subtotal_paise: number;
  gst_paise: number;
  total_paise: number;
  upfront_paise: number;
  upfront_gst_paise: number;
  razorpay_plan_id: string | null;
  razorpay_subscription_id: string | null;
  short_url: string | null;
  status: SubscriptionStatus;
  current_start: number | null;
  current_end: number | null;
  cancelled_at: number | null;
  cancel_reason: string | null;
  replaces_id: string | null;
  starts_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export function isFinal(status: SubscriptionStatus): boolean {
  return FINAL.has(status);
}

export async function findSubscription(db: D1Database, id: string): Promise<SubscriptionRow | null> {
  return db.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first<SubscriptionRow>();
}

export async function findSubscriptionByRazorpayId(db: D1Database, razorpayId: string): Promise<SubscriptionRow | null> {
  return db.prepare("SELECT * FROM subscriptions WHERE razorpay_subscription_id = ?").bind(razorpayId).first<SubscriptionRow>();
}

export async function listSubscriptions(db: D1Database, tenantId: string, limit = 20): Promise<SubscriptionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(tenantId, limit)
    .all<SubscriptionRow>();
  return results ?? [];
}

/**
 * The subscription that pays for the organization now: the newest one that
 * has been authorised and has not ended, preferring one in its paid period.
 */
export function currentSubscription(rows: SubscriptionRow[], now: number): SubscriptionRow | null {
  const live = rows.filter((r) => r.status === "active" || r.status === "pending" || r.status === "halted" || r.status === "authenticated");
  const inPeriod = live.find((r) => r.current_start !== null && r.current_start <= now);
  if (inPeriod) return inPeriod;
  const cancelling = rows.find((r) => r.status === "cancelled" && r.current_end !== null && r.current_end > now);
  return cancelling ?? live.find((r) => !r.replaces_id) ?? null;
}

/** A replacement waiting for, or past, its authorisation, that has not started yet. */
export function pendingReplacement(rows: SubscriptionRow[], now: number): SubscriptionRow | null {
  return (
    rows.find(
      (r) => r.replaces_id !== null && (r.status === "created" || r.status === "authenticated") && (r.starts_at === null || r.starts_at > now)
    ) ?? null
  );
}

export function quoteOf(row: Pick<SubscriptionRow, "tier" | "period" | "extra_workstations" | "remote_seats" | "custom_domain">): TierQuoteInput {
  return {
    tier: row.tier,
    period: row.period,
    extraWorkstations: Number(row.extra_workstations),
    remoteSeats: Number(row.remote_seats),
    customDomain: Number(row.custom_domain) === 1
  };
}

function describe(q: TierQuote, organization: string): string {
  const parts = [`${CATALOGUE[q.tier].label}`, `${q.workstations} workstations`];
  if (q.remoteSeatsTotal) parts.push(`${q.remoteSeatsTotal} Remote Control seat${q.remoteSeatsTotal === 1 ? "" : "s"}`);
  if (q.customDomain) parts.push("custom domain");
  return `Lab Kiosk ${parts.join(", ")}, ${q.period === "month" ? "monthly" : "yearly"}, for ${organization}`.slice(0, 250);
}

export function invoiceLines(q: TierQuote): InvoiceLine[] {
  const period = q.period === "month" ? "1 month" : "1 year";
  const lines: InvoiceLine[] = [];
  if (q.base) lines.push({ description: `Lab Kiosk ${CATALOGUE[q.tier].label}, ${period}, ${CATALOGUE[q.tier].includedWorkstations} workstations`, amount: q.base });
  if (q.extras) lines.push({ description: `${q.extraWorkstations} additional workstation${q.extraWorkstations === 1 ? "" : "s"}, ${period}`, amount: q.extras });
  if (q.remote) lines.push({ description: `Remote Control, ${q.remoteSeats} workstation${q.remoteSeats === 1 ? "" : "s"}, ${period}`, amount: q.remote });
  if (q.domain) lines.push({ description: `Custom domain, ${period}`, amount: q.domain });
  return lines;
}

interface RazorpaySubscription {
  id: string;
  status: string;
  short_url?: string | null;
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  notes?: Record<string, unknown> | unknown[];
}

interface RazorpayInvoice {
  id: string;
  status: string;
  amount: number;
  amount_paid?: number;
  payment_id?: string | null;
  paid_at?: number | null;
  billing_start?: number | null;
  billing_end?: number | null;
  line_items?: Array<{ type?: string }>;
}

export class BillingRefusal extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/**
 * Start a checkout: a subscriptions row, then a Razorpay plan and subscription
 * for it. Any checkout of the organization's that was never authorised is
 * cancelled first, so at most one mandate can be waiting.
 */
export async function startCheckout(
  env: Env,
  db: D1Database,
  input: {
    tenant: Tenant;
    userId: string;
    quote: TierQuote;
    /** The subscription this replaces, for a change; it ends when this starts. */
    replaces?: SubscriptionRow | null;
    /** When the first charge falls; now when absent. */
    startsAt?: number | null;
    /** A one-off charge (paise, GST included) when this is authorised. */
    upfront?: { subtotal: number; gst: number; total: number } | null;
    now: number;
  }
): Promise<SubscriptionRow> {
  const { tenant, quote: q, now } = input;
  if (q.total <= 0) throw new BillingRefusal("There is nothing to pay for", 400);
  await discardOpenCheckouts(env, db, tenant.id, now);
  const id = `ls${crypto.randomUUID().replace(/-/g, "")}`;
  const startsAt = input.startsAt && input.startsAt > now + MIN_START_LEAD ? input.startsAt : null;
  const upfront = input.upfront && input.upfront.total > 0 ? input.upfront : null;
  await db
    .prepare(
      `INSERT INTO subscriptions (id, tenant_id, tier, period, catalogue_version, extra_workstations, remote_seats, custom_domain, subtotal_paise, gst_paise,
                                  total_paise, upfront_paise, upfront_gst_paise, status, replaces_id, starts_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      tenant.id,
      q.tier,
      q.period,
      q.catalogueVersion,
      q.extraWorkstations,
      q.remoteSeats,
      q.customDomain ? 1 : 0,
      q.subtotal,
      q.gst,
      q.total,
      upfront?.total ?? 0,
      upfront?.gst ?? 0,
      input.replaces?.id ?? null,
      startsAt,
      input.userId,
      now,
      now
    )
    .run();
  try {
    const plan = await razorpayJson<{ id?: unknown }>(env, "POST", "/v1/plans", {
      period: q.period === "month" ? "monthly" : "yearly",
      interval: 1,
      item: { name: describe(q, tenant.name).slice(0, 100), amount: q.total, currency: PRICING.currency, description: describe(q, tenant.name) },
      notes: { tenant_id: tenant.id, subscription_ref: id }
    });
    if (typeof plan.id !== "string") throw new RazorpayError("Razorpay did not return a plan id", 502);
    const body: Record<string, unknown> = {
      plan_id: plan.id,
      total_count: TOTAL_COUNT[q.period],
      customer_notify: 1,
      expire_by: now + CHECKOUT_HOURS * 3600,
      notes: { tenant_id: tenant.id, subscription_ref: id }
    };
    if (startsAt) body.start_at = startsAt;
    if (upfront) {
      body.addons = [{ item: { name: "Change for the rest of the current period", amount: upfront.total, currency: PRICING.currency } }];
    }
    const sub = await razorpayJson<RazorpaySubscription>(env, "POST", "/v1/subscriptions", body);
    if (typeof sub.id !== "string" || typeof sub.short_url !== "string") throw new RazorpayError("Razorpay did not return a subscription link", 502);
    await db
      .prepare("UPDATE subscriptions SET razorpay_plan_id = ?, razorpay_subscription_id = ?, short_url = ?, updated_at = ? WHERE id = ?")
      .bind(plan.id, sub.id, sub.short_url, now, id)
      .run();
  } catch (err) {
    await db.prepare("DELETE FROM subscriptions WHERE id = ? AND razorpay_subscription_id IS NULL").bind(id).run();
    if (err instanceof RazorpayError) throw new BillingRefusal(err.message, err.status === 0 ? 503 : 502);
    throw err;
  }
  await writeAuditLog(db, {
    tenantId: tenant.id,
    userId: input.userId,
    action: "billing.checkout",
    details: `subscription=${id} tier=${q.tier} period=${q.period} total=${q.total} upfront=${upfront?.total ?? 0}${input.replaces ? ` replaces=${input.replaces.id}` : ""}`
  });
  return (await findSubscription(db, id))!;
}

/** Cancel at Razorpay every checkout of the organization's still waiting to be authorised. */
export async function discardOpenCheckouts(env: Env, db: D1Database, tenantId: string, now: number): Promise<void> {
  const { results } = await db
    .prepare("SELECT * FROM subscriptions WHERE tenant_id = ? AND status = 'created'")
    .bind(tenantId)
    .all<SubscriptionRow>();
  for (const row of results ?? []) await expireCheckout(env, db, row, now);
}

async function expireCheckout(env: Env, db: D1Database, row: SubscriptionRow, now: number): Promise<void> {
  if (row.razorpay_subscription_id) {
    try {
      await razorpayJson(env, "POST", `/v1/subscriptions/${row.razorpay_subscription_id}/cancel`, { cancel_at_cycle_end: 0 });
    } catch (err) {
      // It may have been authorised meanwhile: look before giving up on it.
      const synced = await syncSubscription(env, db, row, now);
      if (synced.status !== "created") return;
      if (!(err instanceof RazorpayError) || err.status === 0 || err.status >= 500) {
        throw new BillingRefusal("An earlier checkout could not be closed. Try again in a few minutes.", 503);
      }
      console.warn(`[Billing] Razorpay would not cancel unauthorised checkout ${row.id}:`, err.message);
    }
  }
  await db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'created'").bind(now, row.id).run();
}

async function fetchInvoices(env: Env, razorpayId: string): Promise<RazorpayInvoice[]> {
  const all: RazorpayInvoice[] = [];
  for (let skip = 0; skip < 2_000; skip += 100) {
    const page = await razorpayJson<{ items?: unknown }>(env, "GET", `/v1/invoices?subscription_id=${razorpayId}&count=100&skip=${skip}`);
    const items = Array.isArray(page.items) ? (page.items as RazorpayInvoice[]) : [];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

function statusOf(value: unknown): SubscriptionStatus | null {
  return STATUSES.includes(value as SubscriptionStatus) ? (value as SubscriptionStatus) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export interface SyncResult {
  status: SubscriptionStatus;
  /** Payments granted and invoiced by this call. */
  granted: number;
  /** Paid invoices whose amount did not match what was sold: nothing granted. */
  mismatched: string[];
}

/**
 * Fetch a subscription and its invoices from Razorpay and apply them. Safe to
 * call any number of times, in any order. Throws RazorpayError when Razorpay
 * cannot be read, so a webhook answers 500 and is retried.
 */
export async function syncSubscription(env: Env, db: D1Database, row: SubscriptionRow, now: number): Promise<SyncResult> {
  if (!row.razorpay_subscription_id) return { status: row.status, granted: 0, mismatched: [] };
  const remote = await razorpayJson<RazorpaySubscription>(env, "GET", `/v1/subscriptions/${row.razorpay_subscription_id}`);
  const status = statusOf(remote.status) ?? row.status;
  const invoices = await fetchInvoices(env, row.razorpay_subscription_id);
  const tenant = await findTenantById(db, row.tenant_id);
  if (!tenant) return { status, granted: 0, mismatched: [] };

  const currentStart = num(remote.current_start);
  const currentEnd = num(remote.current_end);
  await db
    .prepare(
      `UPDATE subscriptions
          SET status = ?, current_start = COALESCE(?, current_start),
              current_end = MAX(COALESCE(current_end, 0), COALESCE(?, 0)), updated_at = ?
        WHERE id = ?`
    )
    .bind(status, currentStart, currentEnd, now, row.id)
    .run();

  const quote = quoteTier(quoteOf(row), row.subtotal_paise ? Math.round((row.gst_paise * 100) / row.subtotal_paise) : gstPercentFor(env));
  const paid = invoices
    .filter((i) => i.status === "paid" && typeof i.payment_id === "string" && i.payment_id)
    .sort((a, b) => (num(a.billing_start) ?? num(a.paid_at) ?? 0) - (num(b.billing_start) ?? num(b.paid_at) ?? 0));
  let granted = 0;
  const mismatched: string[] = [];
  for (const invoice of paid) {
    const amount = Number(invoice.amount_paid ?? invoice.amount);
    const items = invoice.line_items ?? [];
    const upfrontOnly = items.length > 0 && items.every((l) => l.type === "addon");
    const paymentId = invoice.payment_id as string;
    let statements: D1PreparedStatement[];
    if (upfrontOnly && row.upfront_paise > 0 && amount === row.upfront_paise) {
      statements = upfrontStatements(env, db, tenant, row, quote, paymentId, now);
    } else if (!upfrontOnly && (amount === row.total_paise || amount === row.total_paise + row.upfront_paise)) {
      const periodEnd = num(invoice.billing_end) ?? currentEnd;
      if (periodEnd === null) continue;
      statements = periodStatements(env, db, tenant, row, quote, paymentId, amount, periodEnd, now);
    } else {
      mismatched.push(paymentId);
      continue;
    }
    const results = await db.batch(statements);
    if (results.at(-1)?.meta.changes) granted++;
  }
  if (mismatched.length) await reportMismatch(db, row, mismatched, now);

  await applyStatus(env, db, tenant, row, status, now);
  return { status, granted, mismatched };
}

/** The tenant's limits for what a subscription sells. */
function grantColumns(row: SubscriptionRow): { workstations: number; remoteSeats: number; remoteSeatsTotal: number; customDomain: number } {
  const spec = CATALOGUE[row.tier];
  return {
    workstations: spec.includedWorkstations + Number(row.extra_workstations),
    remoteSeats: Number(row.remote_seats),
    remoteSeatsTotal: spec.includedRemoteSeats + Number(row.remote_seats),
    customDomain: Number(row.custom_domain) === 1 ? 1 : 0
  };
}

/**
 * A charge for a period: extend the plan to the period's end (never back),
 * set the limits when this is the newest period, and issue the invoice. The
 * invoice goes last: every statement is guarded by "not invoiced yet", so a
 * repeat does nothing, and the last one's change count says whether this
 * call granted it.
 */
function periodStatements(
  env: Env,
  db: D1Database,
  tenant: Tenant,
  row: SubscriptionRow,
  quote: TierQuote,
  paymentId: string,
  amount: number,
  periodEnd: number,
  now: number
): D1PreparedStatement[] {
  const g = grantColumns(row);
  const notYet = "NOT EXISTS (SELECT 1 FROM invoices WHERE razorpay_payment_id = ?)";
  const education = row.tier === "education";
  const statements = [
    education
      ? db
          .prepare(
            `UPDATE tenants SET workstation_limit = ?, remote_seats_paid = ?, custom_domain_paid = ?, grace_ends_at = NULL,
                    remote_control_seats = MAX(COALESCE(remote_control_seats, 1), ?)
              WHERE id = ? AND ${notYet}`
          )
          .bind(g.workstations, g.remoteSeats, g.customDomain, g.remoteSeatsTotal, tenant.id, paymentId)
      : db
          .prepare(
            `UPDATE tenants
                SET plan_tier = ?, workstation_limit = ?, remote_seats_paid = ?, custom_domain_paid = ?, grace_ends_at = NULL, staff_limit = NULL,
                    remote_control_seats = MAX(COALESCE(remote_control_seats, 1), ?),
                    license_plan = 'subscriber',
                    license_expires_at = MAX(CASE WHEN license_plan = 'subscriber' THEN COALESCE(license_expires_at, 0) ELSE 0 END, ?)
              WHERE id = ? AND ${notYet}
                AND (license_plan IS NOT 'subscriber' OR license_expires_at IS NULL OR license_expires_at <= ?)`
          )
          .bind(row.tier, g.workstations, g.remoteSeats, g.customDomain, g.remoteSeatsTotal, periodEnd, tenant.id, paymentId, periodEnd),
    // An older period applied late still extends nothing backwards and changes no limits.
    db
      .prepare(
        `UPDATE tenants SET license_expires_at = MAX(COALESCE(license_expires_at, 0), ?)
          WHERE id = ? AND license_plan = 'subscriber' AND ${notYet}`
      )
      .bind(education ? 0 : periodEnd, tenant.id, paymentId),
    ...invoiceStatements(db, env, {
      id: `in${crypto.randomUUID().replace(/-/g, "")}`,
      tenant,
      source: "subscription",
      sourceId: row.id,
      razorpayPaymentId: paymentId,
      subtotal: row.subtotal_paise + (amount > row.total_paise ? row.upfront_paise - row.upfront_gst_paise : 0),
      gst: row.gst_paise + (amount > row.total_paise ? row.upfront_gst_paise : 0),
      total: amount,
      lines: [
        ...invoiceLines(quote),
        ...(amount > row.total_paise ? [{ description: "Change for the rest of the previous period", amount: row.upfront_paise - row.upfront_gst_paise }] : [])
      ],
      issuedAt: now
    })
  ];
  return statements;
}

/** The pro-rated upfront charge of a replacement: the new limits apply at once. */
function upfrontStatements(
  env: Env,
  db: D1Database,
  tenant: Tenant,
  row: SubscriptionRow,
  quote: TierQuote,
  paymentId: string,
  now: number
): D1PreparedStatement[] {
  const g = grantColumns(row);
  const notYet = "NOT EXISTS (SELECT 1 FROM invoices WHERE razorpay_payment_id = ?)";
  const set =
    row.tier === "education"
      ? "workstation_limit = MAX(COALESCE(workstation_limit, 0), ?), remote_seats_paid = MAX(remote_seats_paid, ?), remote_control_seats = MAX(COALESCE(remote_control_seats, 1), ?), custom_domain_paid = MAX(custom_domain_paid, ?)"
      : "plan_tier = ?, workstation_limit = MAX(COALESCE(workstation_limit, 0), ?), remote_seats_paid = MAX(remote_seats_paid, ?), remote_control_seats = MAX(COALESCE(remote_control_seats, 1), ?), custom_domain_paid = MAX(custom_domain_paid, ?)";
  const binds =
    row.tier === "education"
      ? [g.workstations, g.remoteSeats, g.remoteSeatsTotal, g.customDomain]
      : [row.tier, g.workstations, g.remoteSeats, g.remoteSeatsTotal, g.customDomain];
  return [
    db.prepare(`UPDATE tenants SET ${set} WHERE id = ? AND ${notYet}`).bind(...binds, tenant.id, paymentId),
    ...invoiceStatements(db, env, {
      id: `in${crypto.randomUUID().replace(/-/g, "")}`,
      tenant,
      source: "subscription",
      sourceId: row.id,
      razorpayPaymentId: paymentId,
      subtotal: row.upfront_paise - row.upfront_gst_paise,
      gst: row.upfront_gst_paise,
      total: row.upfront_paise,
      lines: [{ description: `Change to ${describe(quote, tenant.name)}, for the rest of the current period`, amount: row.upfront_paise - row.upfront_gst_paise }],
      issuedAt: now
    })
  ];
}

/**
 * A paid amount that does not match what was sold grants nothing; the
 * platform sees it once per payment under Subscriptions, Needs attention.
 */
async function reportMismatch(db: D1Database, row: SubscriptionRow, paymentIds: string[], now: number): Promise<void> {
  for (const paymentId of paymentIds) {
    const recorded = await db
      .prepare(
        `INSERT OR IGNORE INTO billing_events (event_id, event, entity_id, tenant_id, received_at, processed_at, outcome, error)
         VALUES (?, 'amount_mismatch', ?, ?, ?, ?, 'amount_mismatch', ?)`
      )
      .bind(`mismatch:${paymentId}`, row.id, row.tenant_id, now, now, `payment ${paymentId}; expected ${row.total_paise} or upfront ${row.upfront_paise} paise`)
      .run();
    if (!recorded.meta.changes) continue;
    console.error(`[Billing] Subscription ${row.id}: payment ${paymentId} does not match what was sold`);
    await writeAuditLog(db, {
      tenantId: row.tenant_id,
      userId: null,
      action: "billing.amount_mismatch",
      details: `subscription=${row.id} expected=${row.total_paise} upfront=${row.upfront_paise} payment=${paymentId}`
    });
  }
}

/** What a subscription's status means for its organization, beyond its charges. */
async function applyStatus(env: Env, db: D1Database, tenant: Tenant, row: SubscriptionRow, status: SubscriptionStatus, now: number): Promise<void> {
  if (status === "halted" && row.tier !== "education" && tenant.license_plan === "subscriber" && !tenant.grace_ends_at) {
    const graceEnds = now + GRACE_DAYS * DAY;
    await db
      .prepare("UPDATE tenants SET grace_ends_at = ?, license_expires_at = MAX(COALESCE(license_expires_at, 0), ?) WHERE id = ? AND grace_ends_at IS NULL")
      .bind(graceEnds, graceEnds, tenant.id)
      .run();
    await createNotification(db, {
      tenantId: tenant.id,
      kind: "license",
      title: "Payment failed: update your payment method",
      body: `Razorpay could not renew ${tenant.name}'s subscription. The plan stays as it is for ${GRACE_DAYS} days; update the payment method under Plan & billing before then, or the organization moves to Free.`,
      createdBy: null
    });
  }
  if (status === "active" && tenant.grace_ends_at) {
    await db.prepare("UPDATE tenants SET grace_ends_at = NULL WHERE id = ?").bind(tenant.id).run();
  }
  // A replacement that has been authorised takes over: the one it replaces stops charging.
  if (row.replaces_id && (status === "authenticated" || status === "active")) {
    const old = await findSubscription(db, row.replaces_id);
    if (old && old.tenant_id === row.tenant_id && !isFinal(old.status)) await cancelAtRazorpay(env, db, old, now, "replaced");
  }
}

async function cancelAtRazorpay(env: Env, db: D1Database, row: SubscriptionRow, now: number, reason: string): Promise<void> {
  if (row.razorpay_subscription_id) {
    try {
      await razorpayJson(env, "POST", `/v1/subscriptions/${row.razorpay_subscription_id}/cancel`, { cancel_at_cycle_end: 0 });
    } catch (err) {
      // Already cancelled or completed at Razorpay is the result we wanted.
      const remote = await razorpayJson<RazorpaySubscription>(env, "GET", `/v1/subscriptions/${row.razorpay_subscription_id}`);
      if (!isFinal(statusOf(remote.status) ?? "active")) throw err;
    }
  }
  await db
    .prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?), cancel_reason = COALESCE(cancel_reason, ?), updated_at = ? WHERE id = ?")
    .bind(now, reason.slice(0, 500), now, row.id)
    .run();
}

/**
 * The organization cancels: no further charge, the plan stays until the paid
 * period ends. A replacement waiting to start is cancelled with it.
 */
export async function cancelSubscription(
  env: Env,
  db: D1Database,
  input: { tenant: Tenant; userId: string; reason: string; now: number }
): Promise<{ endsAt: number | null }> {
  const rows = await listSubscriptions(db, input.tenant.id);
  const current = currentSubscription(rows, input.now);
  if (!current || isFinal(current.status)) throw new BillingRefusal("There is no subscription to cancel", 409);
  const waiting = pendingReplacement(rows, input.now);
  if (waiting) {
    if (waiting.status === "created") await expireCheckout(env, db, waiting, input.now);
    else await cancelAtRazorpay(env, db, waiting, input.now, "cancelled with the subscription it was to replace");
  }
  await cancelAtRazorpay(env, db, current, input.now, input.reason || "cancelled by the organization");
  await writeAuditLog(db, {
    tenantId: input.tenant.id,
    userId: input.userId,
    action: "billing.cancel",
    details: `subscription=${current.id} ends=${current.current_end ?? "none"}${input.reason ? ` reason=${input.reason.slice(0, 200)}` : ""}`
  });
  return { endsAt: current.current_end };
}

/**
 * Plan a change: what is charged now (a pro-rated upfront add-on for an
 * increase) and when the replacement starts. Nothing is written.
 */
export function planChange(
  current: SubscriptionRow | null,
  next: TierQuote,
  now: number,
  gstPercent: number
): { startsAt: number | null; upfront: { subtotal: number; gst: number; total: number } | null; immediate: boolean } {
  if (!current || (isFinal(current.status) && (current.current_end ?? 0) <= now)) return { startsAt: null, upfront: null, immediate: true };
  const end = current.current_end ?? now;
  const start = current.current_start ?? now;
  if (end <= now + MIN_START_LEAD) return { startsAt: null, upfront: null, immediate: true };
  const samePeriod = current.period === next.period;
  const increase = samePeriod && next.subtotal > current.subtotal_paise && current.status !== "cancelled";
  if (!increase) return { startsAt: end, upfront: null, immediate: false };
  const charge = prorate(current.subtotal_paise, next.subtotal, start, end, now, gstPercent);
  return { startsAt: end, upfront: charge.total > 0 ? charge : null, immediate: false };
}

/** Rows that need a look from the hourly cron: open checkouts, and live ones not seen lately or past their period. */
export async function subscriptionsToReconcile(db: D1Database, now: number, limit = 40): Promise<SubscriptionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM subscriptions
        WHERE razorpay_subscription_id IS NOT NULL
          AND (status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused')
               OR (status = 'cancelled' AND COALESCE(current_end, 0) > ?))
          AND (updated_at < ? OR COALESCE(current_end, 0) < ?)
        ORDER BY updated_at ASC
        LIMIT ?`
    )
    .bind(now - 30 * DAY, now - 6 * 3600, now, limit)
    .all<SubscriptionRow>();
  return results ?? [];
}

/**
 * The hourly cron's look at subscriptions; returns the tenants it changed.
 * `onChange` is told of each change, as a webhook would have been, so a
 * charge or a failure seen only here still reaches the organization.
 */
export async function reconcileSubscriptions(
  env: Env,
  db: D1Database,
  now: number,
  onChange?: (before: SubscriptionRow, result: SyncResult) => Promise<void>
): Promise<string[]> {
  const changed = new Set<string>();
  for (const row of await subscriptionsToReconcile(db, now)) {
    try {
      if (row.status === "created" && row.created_at < now - CHECKOUT_HOURS * 3600) {
        await expireCheckout(env, db, row, now);
        continue;
      }
      const result = await syncSubscription(env, db, row, now);
      if (result.granted || result.status !== row.status) {
        changed.add(row.tenant_id);
        if (onChange) await onChange(row, result);
      }
    } catch (err) {
      console.error(`[Billing] Could not reconcile subscription ${row.id}:`, err instanceof Error ? err.message : err);
      await db.prepare("UPDATE subscriptions SET updated_at = ? WHERE id = ?").bind(now, row.id).run();
    }
  }
  return [...changed];
}
