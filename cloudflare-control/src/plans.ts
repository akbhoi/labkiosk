/**
 * What an organization may run: its plan, its workstation limit, and which of
 * its enrolled workstations the limit covers.
 *
 * The plan is tenants.license_plan (src/license.ts), with these meanings:
 *   NULL        Free: PRICING.freeWorkstations, no end date.
 *   evaluation  Trial: the subscription's workstations for PRICING.trialDays, once.
 *   subscriber  Subscription: paid for a month or a year (src/billing.ts).
 *   education   Education: free after the platform verified the school (src/education.ts).
 *   commercial  Custom: whatever the platform set by hand, such as a large
 *               contract or a complimentary licence.
 * A plan whose end date has passed counts as Free.
 *
 * The limit is tenants.workstation_limit while the plan is in force, and
 * PRICING.freeWorkstations once it has lapsed. Workstations enrolled beyond the
 * limit stay enrolled but are not licensed: the ones seen least recently are
 * listed in unlicensed_workstations, and their kiosk shows a notice instead of
 * the portal (OrgHub.configFor) until the organization pays, removes others, or
 * moves a licence to them.
 */

import { licenseState } from "./license";
import type { LicensePlan, PaidTier, Tenant } from "./types";

export const PRICING = {
  currency: "INR",
  /** Rupees, before GST. */
  monthly: 1999,
  yearly: 19990,
  extraMonthly: 39,
  extraYearly: 390,
  gstPercent: 18,
  includedWorkstations: 45,
  /** Above this many workstations a customer talks to sales instead of paying online. */
  salesAbove: 200,
  freeWorkstations: 5,
  trialDays: 15,
  educationWorkstations: 45,
  educationDays: 365
} as const;

/**
 * What each tier sells, in rupees before GST. The only place prices live:
 * the browser sends a tier, a period and counts, never an amount. A change
 * of price raises CATALOGUE_VERSION; subscriptions keep the amounts they
 * were sold at until their organization authorises new ones.
 */
export const CATALOGUE_VERSION = 1;

export interface TierSpec {
  label: string;
  monthly: number;
  yearly: number;
  includedWorkstations: number;
  extraMonthly: number;
  extraYearly: number;
  staff: number;
  /** Remote Control seats the tier includes at no charge. */
  includedRemoteSeats: number;
  remoteMonthly: number;
  remoteYearly: number;
}

export type SoldTier = PaidTier | "education";

export const CATALOGUE: Readonly<Record<SoldTier, Readonly<TierSpec>>> = Object.freeze({
  starter: Object.freeze({ label: "Starter", monthly: 999, yearly: 9990, includedWorkstations: 15, extraMonthly: 49, extraYearly: 490, staff: 5, includedRemoteSeats: 0, remoteMonthly: 49, remoteYearly: 490 }),
  standard: Object.freeze({ label: "Standard", monthly: 1999, yearly: 19990, includedWorkstations: 45, extraMonthly: 39, extraYearly: 390, staff: 15, includedRemoteSeats: 0, remoteMonthly: 49, remoteYearly: 490 }),
  pro: Object.freeze({ label: "Pro", monthly: 4999, yearly: 49990, includedWorkstations: 120, extraMonthly: 29, extraYearly: 290, staff: 50, includedRemoteSeats: 10, remoteMonthly: 49, remoteYearly: 490 }),
  // Education is free; what it pays for is extra workstations and Remote Control at half price.
  education: Object.freeze({ label: "Education", monthly: 0, yearly: 0, includedWorkstations: 45, extraMonthly: 39, extraYearly: 390, staff: 15, includedRemoteSeats: 0, remoteMonthly: 25, remoteYearly: 245 })
});

export const PAID_TIERS: readonly PaidTier[] = Object.freeze(["starter", "standard", "pro"]);

/** Staff accounts besides the owner, for plans the catalogue does not price. */
export const STAFF_LIMITS = { free: 2, trial: CATALOGUE.standard.staff, custom: 200 } as const;

/** The most Remote Control seats one organization may buy online. */
export const MAX_REMOTE_SEATS = 200;

export function isSoldTier(value: unknown): value is SoldTier {
  return value === "starter" || value === "standard" || value === "pro" || value === "education";
}

export type PlanKind = "free" | "trial" | "subscription" | "education" | "custom";

const KIND_OF: Record<LicensePlan, PlanKind> = {
  evaluation: "trial",
  subscriber: "subscription",
  education: "education",
  commercial: "custom"
};

export const PLAN_LABELS: Record<PlanKind, string> = {
  free: "Free",
  trial: "Trial",
  subscription: "Subscription",
  education: "Education",
  custom: "Custom"
};

export interface Entitlement {
  kind: PlanKind;
  label: string;
  /** The paid tier, for a subscription. */
  tier: PaidTier | null;
  /** How many workstations may be enrolled and licensed. */
  limit: number;
  /** Staff accounts allowed besides the owner. */
  staffLimit: number;
  /** Workstations that may carry a Remote Control seat. */
  remoteSeats: number;
  expiresAt: number | null;
  /** A plan was recorded and its end date has passed: the organization is on Free. */
  lapsed: boolean;
  lapsedFrom: PlanKind | null;
  endingSoon: boolean;
}

type EntitlementTenant = Pick<Tenant, "license_plan" | "license_expires_at" | "workstation_limit"> &
  Partial<Pick<Tenant, "plan_tier" | "staff_limit" | "remote_seats_paid">>;

function staffLimitFor(kind: PlanKind, tenant: EntitlementTenant): number {
  const stored = tenant.staff_limit === null || tenant.staff_limit === undefined ? null : Number(tenant.staff_limit);
  switch (kind) {
    case "free":
      return STAFF_LIMITS.free;
    case "trial":
      return STAFF_LIMITS.trial;
    case "subscription":
      return CATALOGUE[tenant.plan_tier ?? "standard"].staff;
    case "education":
      return CATALOGUE.education.staff;
    case "custom":
      return stored ?? STAFF_LIMITS.custom;
  }
}

export function entitlement(tenant: EntitlementTenant, now = Math.floor(Date.now() / 1000)): Entitlement {
  const state = licenseState(tenant, now);
  const stored = Number(tenant.workstation_limit) || PRICING.freeWorkstations;
  const paidSeats = Math.max(0, Number(tenant.remote_seats_paid) || 0);
  if (state.plan === null) {
    return {
      kind: "free",
      label: PLAN_LABELS.free,
      tier: null,
      limit: stored,
      staffLimit: STAFF_LIMITS.free,
      remoteSeats: paidSeats,
      expiresAt: null,
      lapsed: false,
      lapsedFrom: null,
      endingSoon: false
    };
  }
  const kind = KIND_OF[state.plan];
  if (state.expired) {
    return {
      kind: "free",
      label: PLAN_LABELS.free,
      tier: null,
      limit: Math.min(stored, PRICING.freeWorkstations),
      staffLimit: STAFF_LIMITS.free,
      remoteSeats: 0,
      expiresAt: state.expiresAt,
      lapsed: true,
      lapsedFrom: kind,
      endingSoon: false
    };
  }
  const tier = kind === "subscription" ? (tenant.plan_tier ?? "standard") : null;
  const included = tier ? CATALOGUE[tier].includedRemoteSeats : 0;
  return {
    kind,
    label: tier ? CATALOGUE[tier].label : PLAN_LABELS[kind],
    tier,
    limit: stored,
    staffLimit: staffLimitFor(kind, tenant),
    remoteSeats: paidSeats + included,
    expiresAt: state.expiresAt,
    lapsed: false,
    lapsedFrom: null,
    endingSoon: state.endingSoon
  };
}

/** Whether the organization may start its one trial now. */
export function trialRefusal(tenant: Pick<Tenant, "license_plan" | "license_expires_at" | "workstation_limit" | "trial_started_at">, now?: number): string | null {
  if (tenant.trial_started_at) return "This organization has already had its free trial";
  if (entitlement(tenant, now).kind !== "free") return "The trial is for organizations on the Free plan";
  return null;
}

export type BillingPeriod = "month" | "year";

export interface Quote {
  period: BillingPeriod;
  extraWorkstations: number;
  workstations: number;
  /** Paise. */
  base: number;
  extras: number;
  subtotal: number;
  gst: number;
  total: number;
}

/** The most extra workstations an online payment covers; beyond that, sales. */
export const MAX_ONLINE_EXTRA = PRICING.salesAbove - PRICING.includedWorkstations;

export function quote(period: BillingPeriod, extraWorkstations: number): Quote {
  const base = (period === "month" ? PRICING.monthly : PRICING.yearly) * 100;
  const extras = extraWorkstations * (period === "month" ? PRICING.extraMonthly : PRICING.extraYearly) * 100;
  const subtotal = base + extras;
  const gst = Math.round((subtotal * PRICING.gstPercent) / 100);
  return { period, extraWorkstations, workstations: PRICING.includedWorkstations + extraWorkstations, base, extras, subtotal, gst, total: subtotal + gst };
}

export function parseQuoteInput(body: { period?: unknown; extraWorkstations?: unknown }): { ok: true; value: Quote } | { ok: false; error: string } {
  if (body.period !== "month" && body.period !== "year") return { ok: false, error: "Choose monthly or yearly" };
  const extra = body.extraWorkstations === undefined ? 0 : body.extraWorkstations;
  if (typeof extra !== "number" || !Number.isInteger(extra) || extra < 0) {
    return { ok: false, error: "Extra workstations must be a whole number, 0 or more" };
  }
  if (extra > MAX_ONLINE_EXTRA) {
    return { ok: false, error: `For more than ${PRICING.salesAbove} workstations, contact sales` };
  }
  return { ok: true, value: quote(body.period, extra) };
}

// ------------------------------------------------------------ subscriptions

export interface TierQuoteInput {
  tier: SoldTier;
  period: BillingPeriod;
  extraWorkstations: number;
  remoteSeats: number;
}

export interface TierQuote extends TierQuoteInput {
  catalogueVersion: number;
  workstations: number;
  staff: number;
  /** Remote Control seats in all: the paid ones plus any the tier includes. */
  remoteSeatsTotal: number;
  /** Paise, before GST. */
  base: number;
  extras: number;
  remote: number;
  subtotal: number;
  gstPercent: number;
  gst: number;
  total: number;
}

/**
 * The price of a tier with its extras, in paise. GST is charged only once the
 * seller is registered for it (src/invoices.ts gstPercentFor).
 */
export function quoteTier(input: TierQuoteInput, gstPercent: number): TierQuote {
  const spec = CATALOGUE[input.tier];
  const yearly = input.period === "year";
  const base = (yearly ? spec.yearly : spec.monthly) * 100;
  const extras = input.extraWorkstations * (yearly ? spec.extraYearly : spec.extraMonthly) * 100;
  const remote = input.remoteSeats * (yearly ? spec.remoteYearly : spec.remoteMonthly) * 100;
  const subtotal = base + extras + remote;
  const gst = Math.round((subtotal * gstPercent) / 100);
  return {
    ...input,
    catalogueVersion: CATALOGUE_VERSION,
    workstations: spec.includedWorkstations + input.extraWorkstations,
    staff: spec.staff,
    remoteSeatsTotal: spec.includedRemoteSeats + input.remoteSeats,
    base,
    extras,
    remote,
    subtotal,
    gstPercent,
    gst,
    total: subtotal + gst
  };
}

function wholeCount(value: unknown, label: string): { ok: true; value: number } | { ok: false; error: string } {
  const v = value === undefined ? 0 : value;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return { ok: false, error: `${label} must be a whole number, 0 or more` };
  return { ok: true, value: v };
}

/** Validate what the browser sent for a subscription: a tier, a period and counts. */
export function parseTierQuoteInput(body: {
  tier?: unknown;
  period?: unknown;
  extraWorkstations?: unknown;
  remoteSeats?: unknown;
}): { ok: true; value: TierQuoteInput } | { ok: false; error: string } {
  if (!isSoldTier(body.tier)) return { ok: false, error: "Choose Starter, Standard or Pro" };
  if (body.period !== "month" && body.period !== "year") return { ok: false, error: "Choose monthly or yearly" };
  const extra = wholeCount(body.extraWorkstations, "Extra workstations");
  if (!extra.ok) return extra;
  const seats = wholeCount(body.remoteSeats, "Remote Control seats");
  if (!seats.ok) return seats;
  const spec = CATALOGUE[body.tier];
  if (spec.includedWorkstations + extra.value > PRICING.salesAbove) {
    return { ok: false, error: `For more than ${PRICING.salesAbove} workstations, contact sales` };
  }
  if (seats.value > MAX_REMOTE_SEATS) return { ok: false, error: `For more than ${MAX_REMOTE_SEATS} Remote Control seats, contact sales` };
  if (spec.includedRemoteSeats + seats.value > spec.includedWorkstations + extra.value) {
    return { ok: false, error: "Remote Control seats cannot outnumber the workstations" };
  }
  if (body.tier === "education" && extra.value === 0 && seats.value === 0) {
    return { ok: false, error: "Education is free: choose extra workstations or Remote Control seats to pay for" };
  }
  return { ok: true, value: { tier: body.tier, period: body.period, extraWorkstations: extra.value, remoteSeats: seats.value } };
}

/**
 * What a mid-term increase costs now: the difference in subtotal for the part
 * of the period that is left, plus GST, in paise. Rounded up to the rupee so
 * the charge never undercuts the price; 0 when nothing goes up.
 */
export function prorate(
  oldSubtotal: number,
  newSubtotal: number,
  periodStart: number,
  periodEnd: number,
  now: number,
  gstPercent: number
): { subtotal: number; gst: number; total: number } {
  const length = periodEnd - periodStart;
  const left = Math.min(Math.max(periodEnd - now, 0), length);
  const difference = newSubtotal - oldSubtotal;
  if (difference <= 0 || length <= 0 || left <= 0) return { subtotal: 0, gst: 0, total: 0 };
  const subtotal = Math.max(100, Math.ceil((difference * left) / length / 100) * 100);
  const gst = Math.round((subtotal * gstPercent) / 100);
  return { subtotal, gst, total: subtotal + gst };
}

/** Whether a subscription change is an increase (charged now) or not (at renewal). */
export function isIncrease(from: TierQuoteInput, to: TierQuoteInput): boolean {
  const a = quoteTier(from, 0);
  const b = quoteTier({ ...to, period: from.period }, 0);
  return to.period === from.period && b.subtotal > a.subtotal && b.workstations >= a.workstations && b.remoteSeatsTotal >= a.remoteSeatsTotal;
}

// ------------------------------------------------------------ licensed slots

export interface EnrolledWorkstation {
  clientId: string;
  lastSeen: number;
  licensed: boolean;
  /** When it lost its licence (unix seconds), for those that are not licensed. */
  since: number | null;
}

export async function listEnrolledWorkstations(db: D1Database, tenantId: string): Promise<EnrolledWorkstation[]> {
  const { results } = await db
    .prepare(
      `SELECT t.client_id AS client_id, COALESCE(MAX(c.last_seen), 0) AS last_seen, u.since AS since
         FROM (SELECT DISTINCT client_id FROM device_tokens WHERE tenant_id = ? AND revoked = 0) t
         LEFT JOIN client_devices c ON c.tenant_id = ? AND c.client_id = t.client_id
         LEFT JOIN unlicensed_workstations u ON u.tenant_id = ? AND u.client_id = t.client_id
        GROUP BY t.client_id, u.since`
    )
    .bind(tenantId, tenantId, tenantId)
    .all<{ client_id: string; last_seen: number; since: number | null }>();
  return (results ?? []).map((r) => ({
    clientId: r.client_id,
    lastSeen: Number(r.last_seen) || 0,
    licensed: r.since === null,
    since: r.since === null ? null : Number(r.since)
  }));
}

/** The workstations of an organization that are not licensed, and since when (for OrgHub). */
export async function listUnlicensed(db: D1Database, tenantId: string): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT client_id, since FROM unlicensed_workstations WHERE tenant_id = ?")
    .bind(tenantId)
    .all<{ client_id: string; since: number }>();
  return new Map((results ?? []).map((r) => [r.client_id, Number(r.since)]));
}

export interface Rebalance {
  /** Workstations that lost their licence. */
  unlicensed: string[];
  /** Workstations that got one back. */
  relicensed: string[];
}

/**
 * Make the licensed workstations fit the limit: beyond it, the ones seen least
 * recently lose their licence; below it, the ones seen most recently get theirs
 * back. Sticky otherwise, so a workstation showing the notice does not swap
 * places with another just by being online.
 */
export async function rebalanceLicences(db: D1Database, tenantId: string, limit: number, nowSeconds: number): Promise<Rebalance> {
  await db
    .prepare(
      "DELETE FROM unlicensed_workstations WHERE tenant_id = ? AND client_id NOT IN (SELECT client_id FROM device_tokens WHERE tenant_id = ? AND revoked = 0)"
    )
    .bind(tenantId, tenantId)
    .run();
  const all = await listEnrolledWorkstations(db, tenantId);
  const licensed = all.filter((w) => w.licensed).sort((a, b) => a.lastSeen - b.lastSeen || a.clientId.localeCompare(b.clientId));
  const waiting = all.filter((w) => !w.licensed).sort((a, b) => b.lastSeen - a.lastSeen || a.clientId.localeCompare(b.clientId));
  const result: Rebalance = { unlicensed: [], relicensed: [] };
  if (licensed.length > limit) {
    result.unlicensed = licensed.slice(0, licensed.length - limit).map((w) => w.clientId);
  } else if (licensed.length < limit && waiting.length) {
    result.relicensed = waiting.slice(0, limit - licensed.length).map((w) => w.clientId);
  }
  const statements = [
    ...result.unlicensed.map((clientId) =>
      db.prepare("INSERT OR IGNORE INTO unlicensed_workstations (tenant_id, client_id, since) VALUES (?, ?, ?)").bind(tenantId, clientId, nowSeconds)
    ),
    ...result.relicensed.map((clientId) =>
      db.prepare("DELETE FROM unlicensed_workstations WHERE tenant_id = ? AND client_id = ?").bind(tenantId, clientId)
    )
  ];
  if (statements.length) await db.batch(statements);
  return result;
}

/**
 * Give a workstation that is not licensed the licence of the licensed one seen
 * least recently, or a free place when there is one. Returns the workstation
 * that lost its licence (null when there was a free place), or an error.
 */
export async function moveLicenceTo(
  db: D1Database,
  tenantId: string,
  clientId: string,
  limit: number,
  nowSeconds: number
): Promise<{ ok: true; displaced: string | null } | { ok: false; error: string; status: number }> {
  const all = await listEnrolledWorkstations(db, tenantId);
  const target = all.find((w) => w.clientId === clientId);
  if (!target) return { ok: false, error: "That workstation is not enrolled", status: 404 };
  if (target.licensed) return { ok: false, error: "That workstation is already licensed", status: 409 };
  const licensed = all.filter((w) => w.licensed).sort((a, b) => a.lastSeen - b.lastSeen || a.clientId.localeCompare(b.clientId));
  const statements = [db.prepare("DELETE FROM unlicensed_workstations WHERE tenant_id = ? AND client_id = ?").bind(tenantId, clientId)];
  let displaced: string | null = null;
  if (licensed.length >= limit) {
    if (!licensed.length) return { ok: false, error: "The plan licenses no workstation", status: 409 };
    displaced = licensed[0].clientId;
    statements.push(
      db.prepare("INSERT OR IGNORE INTO unlicensed_workstations (tenant_id, client_id, since) VALUES (?, ?, ?)").bind(tenantId, displaced, nowSeconds)
    );
  }
  await db.batch(statements);
  return { ok: true, displaced };
}
