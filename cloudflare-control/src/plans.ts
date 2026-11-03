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
import type { LicensePlan, Tenant } from "./types";

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
  /** How many workstations may be enrolled and licensed. */
  limit: number;
  expiresAt: number | null;
  /** A plan was recorded and its end date has passed: the organization is on Free. */
  lapsed: boolean;
  lapsedFrom: PlanKind | null;
  endingSoon: boolean;
}

export function entitlement(
  tenant: Pick<Tenant, "license_plan" | "license_expires_at" | "workstation_limit">,
  now = Math.floor(Date.now() / 1000)
): Entitlement {
  const state = licenseState(tenant, now);
  const stored = Number(tenant.workstation_limit) || PRICING.freeWorkstations;
  if (state.plan === null) {
    return { kind: "free", label: PLAN_LABELS.free, limit: stored, expiresAt: null, lapsed: false, lapsedFrom: null, endingSoon: false };
  }
  const kind = KIND_OF[state.plan];
  if (state.expired) {
    return {
      kind: "free",
      label: PLAN_LABELS.free,
      limit: Math.min(stored, PRICING.freeWorkstations),
      expiresAt: state.expiresAt,
      lapsed: true,
      lapsedFrom: kind,
      endingSoon: false
    };
  }
  return { kind, label: PLAN_LABELS[kind], limit: stored, expiresAt: state.expiresAt, lapsed: false, lapsedFrom: null, endingSoon: state.endingSoon };
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
