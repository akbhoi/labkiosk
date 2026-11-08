/**
 * The routes behind Plan & billing in an organization's console and
 * Subscriptions in the Super Admin console (src/subscriptions.ts,
 * src/invoices.ts, src/limits.ts). handleBillingRoutes answers a request it
 * owns and returns null for any other.
 *
 * Organization (the `settings` permission; cancelling and resuming are the owner's):
 *   GET  /api/billing                    plan, subscription, usage, prices, invoices, details
 *   POST /api/billing/preview            {tier, period, extraWorkstations, remoteSeats}: price, what changes and when
 *   POST /api/billing/checkout           the same: a Razorpay subscription to authorise
 *   POST /api/billing/cancel             {reason}: no further charge; the plan lasts to the end of the period
 *   POST /api/billing/resume             a new authorisation that starts when the paid period ends
 *   POST /api/billing/refresh            look at Razorpay now (the payer is back from authorising)
 *   POST /api/billing/details            {legalName, gstin, address, state}
 *   GET  /api/billing/invoices/:id       one invoice, as JSON
 *   GET  /api/billing/documents/:kind/:id  an invoice or proforma as its printable page
 *   POST /api/billing/remote-seats       {clientId, assigned}
 *   POST /api/billing/staff              {userId, suspended} (also the `staff` permission)
 * Platform:
 *   GET  /api/super/billing              revenue, subscriptions, what needs attention
 *   GET  /api/super/billing/tenants/:id  one organization's subscriptions, events, invoices, payments
 *   POST /api/super/billing/sync         {subscriptionId}
 *   POST /api/super/billing/cancel       {subscriptionId, immediately}
 *   POST /api/super/billing/extend       {tenantId, days}
 *   POST /api/super/billing/payment-link {tenantId, tier, period, extraWorkstations, remoteSeats, mode, note}
 *   GET  /api/super/billing/gstr1?month=YYYY-MM&section=b2b|b2cl|b2cs|hsn|docs  the month's GSTR-1 as CSV
 *
 * And, with no session: GET /billing/document/:token, a private link to one
 * invoice or proforma, emailed to the organization (src/billing_documents.ts).
 */

import { generateNonce } from "./auth";
import { billingEnabled, RazorpayError, rupees } from "./billing";
import {
  createProforma,
  documentHeaders,
  documentView,
  emailDocument,
  emailPaidInvoice,
  GSTR1_SECTIONS,
  gstr1Csv,
  listProformas,
  renderDocumentPage,
  resolveDocumentLink,
  type DocumentKind,
  type Gstr1Section,
  type Proforma
} from "./billing_documents";
import { findTenantById, findUserById, getTenantUserPermissions, updateTenant, writeAuditLog } from "./db";
import { isDemoTenant } from "./demo";
import { jsonError, requireSuperAdmin, requireTenantPermission } from "./guard";
import { findInvoice, GST_STATES, gstPercentFor, listInvoices, sellerFrom, validGstin, type Invoice } from "./invoices";
import { licenseDate } from "./license";
import { activeStaffCount, assignRemoteSeat, listRemoteSeats, listStaff, setStaffSuspended } from "./limits";
import { mailConfigProblem, sendMail } from "./mail";
import { createNotification } from "./notifications";
import { syncLicences } from "./plan_sync";
import {
  CATALOGUE,
  entitlement,
  listEnrolledWorkstations,
  MAX_REMOTE_SEATS,
  parseTierQuoteInput,
  PRICING,
  quoteTier,
  STAFF_LIMITS,
  type SoldTier,
  type TierQuote
} from "./plans";
import type { RouteContext } from "./signup";
import {
  BillingRefusal,
  cancelSubscription,
  currentSubscription,
  findSubscription,
  isFinal,
  listSubscriptions,
  pendingReplacement,
  planChange,
  quoteOf,
  startCheckout,
  syncSubscription,
  type SubscriptionRow,
  type SubscriptionStatus
} from "./subscriptions";
import type { Env, Tenant } from "./types";

const DAY = 86_400;
/** How long a link the platform sends stays open. */
const PLATFORM_LINK_HOURS = 7 * 24;
/** A yearly renewal is announced this long before it is charged. */
const RENEWAL_NOTICE_DAYS = 7;
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const USER_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface BillingRouteContext extends RouteContext {
  method: string;
  path: string;
  tenant: Tenant | null;
}

function json(data: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function refusal(err: unknown, headers: Record<string, string>): Response {
  if (err instanceof BillingRefusal) return jsonError(err.message, err.status, headers);
  if (err instanceof RazorpayError) return jsonError(err.message, err.status === 0 ? 503 : 502, headers);
  throw err;
}

export function handleBillingRoutes(ctx: BillingRouteContext): Promise<Response> | null {
  const { path } = ctx;
  const link = /^\/billing\/document\/([0-9a-f]{64})$/.exec(path);
  if (link && ctx.method === "GET") return linkedDocument(ctx, link[1]);
  if (path === "/api/billing" || (path.startsWith("/api/billing/") && path !== "/api/billing/return" && !path.startsWith("/api/billing/razorpay/"))) {
    return organizationBilling(ctx);
  }
  if (path === "/api/super/billing" || path.startsWith("/api/super/billing/")) return platformBilling(ctx);
  return null;
}

// ------------------------------------------------------------------ documents

const DOCUMENT_ID: Record<DocumentKind, RegExp> = { invoice: /^in[0-9a-f]{32}$/, proforma: /^pf[0-9a-f]{32}$/ };

/** The document as its page; null when this organization has no such document. */
async function documentPage(ctx: RouteContext, tenantId: string, kind: DocumentKind, id: string): Promise<Response | null> {
  const view = await documentView(ctx.db, tenantId, kind, id);
  if (!view) return null;
  const nonce = generateNonce();
  return new Response(renderDocumentPage(view, sellerFrom(ctx.env), nonce), { headers: documentHeaders(nonce, ctx.url.protocol === "https:") });
}

/** GET /billing/document/<token>: the private link in an email. The token is the only credential. */
async function linkedDocument(ctx: BillingRouteContext, token: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const found = await resolveDocumentLink(ctx.db, token, now);
  const page = found ? await documentPage(ctx, found.tenantId, found.kind, found.documentId) : null;
  if (page) return page;
  return new Response("This link is not valid or has expired. Every invoice is under Plan & billing in your organization's console.", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" }
  });
}

function proformaJson(p: Proforma, payUrl: string | null) {
  return {
    id: p.id,
    number: p.number,
    reason: p.reason,
    status: p.status,
    createdAt: Number(p.created_at),
    validUntil: Number(p.valid_until),
    total: Number(p.total_paise),
    payUrl: p.status === "open" ? payUrl : null
  };
}

async function proformasJson(db: D1Database, tenantId: string) {
  const out = [];
  for (const p of await listProformas(db, tenantId, 20)) {
    const pay =
      p.payment_id && p.status === "open"
        ? await db.prepare("SELECT short_url FROM payments WHERE id = ? AND tenant_id = ?").bind(p.payment_id, tenantId).first<{ short_url: string | null }>()
        : null;
    out.push(proformaJson(p, pay?.short_url ?? null));
  }
  return out;
}

// ----------------------------------------------------------------- shared JSON

export function subscriptionJson(r: SubscriptionRow) {
  const q = quoteTier(quoteOf(r), 0);
  return {
    id: r.id,
    tier: r.tier,
    tierLabel: CATALOGUE[r.tier].label,
    period: r.period,
    status: r.status,
    workstations: q.workstations,
    remoteSeats: Number(r.remote_seats),
    remoteSeatsTotal: q.remoteSeatsTotal,
    extraWorkstations: Number(r.extra_workstations),
    subtotal: Number(r.subtotal_paise),
    gst: Number(r.gst_paise),
    total: Number(r.total_paise),
    upfront: Number(r.upfront_paise),
    currentStart: r.current_start === null ? null : Number(r.current_start),
    currentEnd: r.current_end === null ? null : Number(r.current_end),
    startsAt: r.starts_at === null ? null : Number(r.starts_at),
    cancelledAt: r.cancelled_at === null ? null : Number(r.cancelled_at),
    replacesId: r.replaces_id,
    // The payer's way to authorise is shown only while it is still waiting.
    authoriseUrl: r.status === "created" ? r.short_url : null,
    razorpayId: r.razorpay_subscription_id,
    createdAt: Number(r.created_at)
  };
}

function invoiceJson(i: Invoice) {
  return {
    id: i.id,
    number: i.number,
    issuedAt: Number(i.issued_at),
    subtotal: Number(i.subtotal_paise),
    cgst: Number(i.cgst_paise),
    sgst: Number(i.sgst_paise),
    igst: Number(i.igst_paise),
    total: Number(i.total_paise),
    taxInvoice: Boolean(i.seller_gstin)
  };
}

function catalogueJson(gstPercent: number) {
  return {
    currency: PRICING.currency,
    gstPercent,
    salesAbove: PRICING.salesAbove,
    maxRemoteSeats: MAX_REMOTE_SEATS,
    freeWorkstations: PRICING.freeWorkstations,
    freeStaff: STAFF_LIMITS.free,
    tiers: (["starter", "standard", "pro", "education"] as SoldTier[]).map((tier) => ({ tier, ...CATALOGUE[tier] }))
  };
}

function quoteJson(q: TierQuote) {
  return {
    tier: q.tier,
    period: q.period,
    extraWorkstations: q.extraWorkstations,
    remoteSeats: q.remoteSeats,
    workstations: q.workstations,
    staff: q.staff,
    remoteSeatsTotal: q.remoteSeatsTotal,
    base: q.base,
    extras: q.extras,
    remote: q.remote,
    subtotal: q.subtotal,
    gstPercent: q.gstPercent,
    gst: q.gst,
    total: q.total
  };
}

/**
 * The paid period an organization is in when it has no subscription row: a
 * plan paid through a payment link before subscriptions, treated as current
 * so that a change from it is pro-rated rather than paid twice.
 */
async function legacyCurrent(db: D1Database, tenant: Tenant, now: number): Promise<SubscriptionRow | null> {
  const plan = entitlement(tenant, now);
  if (plan.kind !== "subscription" || plan.expiresAt === null || plan.expiresAt <= now) return null;
  const paid = await db
    .prepare("SELECT * FROM payments WHERE tenant_id = ? AND status = 'paid' ORDER BY paid_at DESC, rowid DESC LIMIT 1")
    .bind(tenant.id)
    .first<{
      id: string;
      period: "month" | "year";
      extra_workstations: number;
      remote_seats: number;
      tier: SoldTier | null;
      subtotal_paise: number;
      gst_paise: number;
      total_paise: number;
      paid_at: number;
    }>();
  if (!paid) return null;
  return {
    id: `legacy:${paid.id}`,
    tenant_id: tenant.id,
    tier: paid.tier ?? plan.tier ?? "standard",
    period: paid.period,
    catalogue_version: 0,
    extra_workstations: Number(paid.extra_workstations),
    remote_seats: Number(paid.remote_seats) || 0,
    subtotal_paise: Number(paid.subtotal_paise),
    gst_paise: Number(paid.gst_paise),
    total_paise: Number(paid.total_paise),
    upfront_paise: 0,
    upfront_gst_paise: 0,
    razorpay_plan_id: null,
    razorpay_subscription_id: null,
    short_url: null,
    status: "active",
    current_start: Math.min(Number(paid.paid_at), plan.expiresAt),
    current_end: plan.expiresAt,
    cancelled_at: null,
    cancel_reason: null,
    replaces_id: null,
    starts_at: null,
    created_by: null,
    created_at: Number(paid.paid_at),
    updated_at: Number(paid.paid_at)
  };
}

async function currentFor(db: D1Database, tenant: Tenant, rows: SubscriptionRow[], now: number): Promise<SubscriptionRow | null> {
  return currentSubscription(rows, now) ?? (await legacyCurrent(db, tenant, now));
}

function consoleUrl(ctx: RouteContext, tenant: Pick<Tenant, "subdomain">, query = ""): string {
  const q = query ? `${query}&` : "";
  return ctx.isDev
    ? `${ctx.url.origin}/admin/plan?${q}tenant=${encodeURIComponent(tenant.subdomain)}`
    : `https://${tenant.subdomain}.${ctx.baseDomain}/admin/plan${query ? `?${query}` : ""}`;
}

/** Best effort: a billing email to the organization's owner. */
async function emailOwner(
  env: Env,
  db: D1Database,
  tenant: Tenant,
  mail: { subject: string; title: string; lead: string; details: Array<[string, string]>; action?: { label: string; url: string } | null; tone?: "success" | "warning" | "danger"; text: string }
): Promise<boolean> {
  if (mailConfigProblem(env)) return false;
  const owner = tenant.user_id ? await findUserById(db, tenant.user_id) : null;
  if (!owner) return false;
  try {
    await sendMail(env, {
      to: owner.email,
      toName: owner.name,
      subject: mail.subject,
      text: `${mail.lead}\n\n${mail.details.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${mail.action ? `${mail.action.label}: ${mail.action.url}\n\n` : ""}${mail.text}`,
      template: { name: "billing", title: mail.title, lead: mail.lead, details: mail.details, action: mail.action ?? null, tone: mail.tone ?? null }
    });
    return true;
  } catch (err) {
    console.error(`[Billing] Could not email the owner of ${tenant.id}:`, err);
    return false;
  }
}

export function describePlan(r: Pick<SubscriptionRow, "tier" | "period" | "extra_workstations" | "remote_seats">): string {
  const q = quoteTier(quoteOf(r), 0);
  const seats = q.remoteSeatsTotal ? `, ${q.remoteSeatsTotal} Remote Control seat${q.remoteSeatsTotal === 1 ? "" : "s"}` : "";
  return `${CATALOGUE[r.tier].label}, ${r.period === "month" ? "monthly" : "yearly"}, ${q.workstations} workstations${seats}`;
}

/**
 * After a subscription changed (webhook, return, cron, platform): apply the
 * plan to workstations, staff and seats, and tell the organization what
 * happened, once per change.
 */
export async function afterSubscriptionChange(
  env: Env,
  db: D1Database,
  before: SubscriptionRow,
  status: SubscriptionStatus,
  granted: number,
  now: number
): Promise<void> {
  await syncLicences(env, db, before.tenant_id, now * 1000);
  const tenant = await findTenantById(db, before.tenant_id);
  if (!tenant) return;
  const url = env.DEFAULT_DOMAIN ? `https://${tenant.subdomain}.${env.DEFAULT_DOMAIN}/admin/plan` : "";
  if (granted) {
    const latest = await db
      .prepare("SELECT * FROM invoices WHERE tenant_id = ? AND source_id = ? ORDER BY issued_at DESC, number DESC LIMIT 1")
      .bind(tenant.id, before.id)
      .first<Invoice>();
    const fresh = (await findSubscription(db, before.id)) ?? before;
    const ends = entitlement(tenant, now).expiresAt;
    await createNotification(db, {
      tenantId: tenant.id,
      kind: "license",
      title: "Payment received",
      body: `Thank you. ${tenant.name} is on ${describePlan(fresh)}${ends ? `, paid until ${licenseDate(ends)}` : ""}.${latest ? ` Invoice ${latest.number}.` : ""}`,
      createdBy: null
    });
    const sent = await emailPaidInvoice(env, db, tenant, before.id, now, null, { plan: describePlan(fresh), paidUntil: ends ? licenseDate(ends) : null });
    if (!sent) {
      await emailOwner(env, db, tenant, {
        subject: `Payment received: Lab Kiosk ${CATALOGUE[fresh.tier].label}`,
        title: "Payment received",
        lead: `Thank you. ${tenant.name}'s plan is paid${ends ? ` until ${licenseDate(ends)}` : ""}.`,
        details: [["Plan", describePlan(fresh)]],
        action: url ? { label: "View invoices", url } : null,
        tone: "success",
        text: "Invoices are under Plan & billing in your console."
      });
    }
  }
  if (status !== before.status && status === "halted") {
    await emailOwner(env, db, tenant, {
      subject: "Action needed: your Lab Kiosk payment failed",
      title: "Payment failed",
      lead: `Razorpay could not renew ${tenant.name}'s subscription after several attempts. The plan stays as it is for 7 more days.`,
      details: [["Plan", describePlan(before)], ["Amount", rupees(Number(before.total_paise))]],
      action: url ? { label: "Update payment", url } : null,
      tone: "danger",
      text: "Update the payment method under Plan & billing, or the organization moves to the Free plan when the 7 days are over."
    });
  }
  if (status !== before.status && status === "pending") {
    await createNotification(db, {
      tenantId: tenant.id,
      kind: "license",
      title: "A renewal payment failed",
      body: `Razorpay could not charge ${rupees(Number(before.total_paise))} for ${tenant.name}'s renewal and will try again. Check the card or UPI mandate under Plan & billing.`,
      createdBy: null
    });
  }
}

// --------------------------------------------------------------- organization

async function organizationBilling(ctx: BillingRouteContext): Promise<Response> {
  const { db, env, session, jsonHeaders, path, method, request } = ctx;
  const denied = await requireTenantPermission(db, session, ctx.tenant, "settings", jsonHeaders);
  if (denied) return denied;
  const tenant = ctx.tenant!;
  const userId = session!.user_id;
  const now = Math.floor(Date.now() / 1000);
  const isOwner = tenant.user_id === userId || isDemoTenant(tenant, userId);
  const gstPercent = gstPercentFor(env);

  if (path === "/api/billing" && method === "GET") {
    const rows = await listSubscriptions(db, tenant.id);
    const current = await currentFor(db, tenant, rows, now);
    const replacement = pendingReplacement(rows, now);
    const waiting = rows.find((r) => r.status === "created" && !r.replaces_id && r.created_at > now - DAY) ?? null;
    const plan = entitlement(tenant, now);
    const workstations = await listEnrolledWorkstations(db, tenant.id);
    const seats = await listRemoteSeats(db, tenant.id);
    const perms = await getTenantUserPermissions(db, tenant.id, userId);
    const canSeeStaff = isOwner || perms.includes("*") || perms.includes("staff");
    const seller = sellerFrom(env);
    return json(
      {
        enabled: billingEnabled(env),
        isOwner,
        gstRegistered: Boolean(seller.gstin),
        plan: {
          kind: plan.kind,
          label: plan.label,
          tier: plan.tier,
          workstations: plan.limit,
          staff: plan.staffLimit,
          remoteSeats: plan.remoteSeats,
          expiresAt: plan.expiresAt,
          lapsed: plan.lapsed,
          endingSoon: plan.endingSoon,
          graceEndsAt: tenant.grace_ends_at ?? null,
          trialAvailable: !tenant.trial_started_at && plan.kind === "free"
        },
        usage: {
          workstations: workstations.length,
          licensed: workstations.filter((w) => w.licensed).length,
          staff: await activeStaffCount(db, tenant),
          remoteSeats: seats.length
        },
        subscription: current ? { ...subscriptionJson(current), legacy: current.id.startsWith("legacy:") } : null,
        replacement: replacement ? subscriptionJson(replacement) : null,
        waitingCheckout: waiting ? subscriptionJson(waiting) : null,
        catalogue: catalogueJson(gstPercent),
        invoices: (await listInvoices(db, tenant.id, 50)).map(invoiceJson),
        proformas: await proformasJson(db, tenant.id),
        details: {
          legalName: tenant.billing_legal_name ?? "",
          gstin: tenant.billing_gstin ?? "",
          address: tenant.billing_address ?? "",
          state: tenant.billing_state ?? ""
        },
        states: GST_STATES,
        remote: {
          workstations: workstations
            .sort((a, b) => b.lastSeen - a.lastSeen || a.clientId.localeCompare(b.clientId))
            .slice(0, 500)
            .map((w) => ({ clientId: w.clientId, lastSeen: w.lastSeen, assigned: seats.some((s) => s.clientId === w.clientId) }))
        },
        staff: canSeeStaff
          ? (await listStaff(db, tenant)).map((s) => ({ userId: s.userId, name: s.name, email: s.email, role: s.role, suspended: s.suspendedAt !== null }))
          : null
      },
      jsonHeaders
    );
  }

  if ((path === "/api/billing/preview" || path === "/api/billing/checkout") && method === "POST") {
    const body = await readJson(request);
    if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
    const parsed = parseTierQuoteInput(body);
    if (!parsed.ok) return jsonError(parsed.error, 400, jsonHeaders);
    if (parsed.value.tier === "education" && entitlement(tenant, now).kind !== "education") {
      return jsonError("Education prices are for organizations on the Education plan", 403, jsonHeaders);
    }
    if (parsed.value.remoteSeats > 0 && tenant.remote_control_revoked_at && tenant.remote_control_status === "rejected") {
      return jsonError("Lab Kiosk has turned Remote Control off for this organization; contact support", 403, jsonHeaders);
    }
    const quote = quoteTier(parsed.value, gstPercent);
    const rows = await listSubscriptions(db, tenant.id);
    const current = await currentFor(db, tenant, rows, now);
    const change = planChange(current, quote, now, gstPercent);
    if (path === "/api/billing/preview") {
      const workstations = await listEnrolledWorkstations(db, tenant.id);
      const seats = await listRemoteSeats(db, tenant.id);
      const staff = await activeStaffCount(db, tenant);
      return json(
        {
          quote: quoteJson(quote),
          chargedNow: change.immediate ? quote.total : (change.upfront?.total ?? 0),
          upfront: change.upfront,
          startsAt: change.startsAt,
          immediate: change.immediate,
          same: Boolean(
            current &&
              !isFinal(current.status) &&
              current.tier === quote.tier &&
              current.period === quote.period &&
              Number(current.extra_workstations) === quote.extraWorkstations &&
              Number(current.remote_seats) === quote.remoteSeats
          ),
          losses: {
            workstations: Math.max(0, workstations.length - quote.workstations),
            staff: Math.max(0, staff - quote.staff),
            remoteSeats: Math.max(0, seats.length - quote.remoteSeatsTotal)
          }
        },
        jsonHeaders
      );
    }
    if (!billingEnabled(env)) return jsonError("Online payment is not set up yet; contact sales", 503, jsonHeaders);
    if (!isOwner && !(await getTenantUserPermissions(db, tenant.id, userId)).includes("*")) {
      return jsonError("Only the organization's owner or an organization admin can change the plan", 403, jsonHeaders);
    }
    if (current && !current.id.startsWith("legacy:") && !isFinal(current.status) && current.tier === quote.tier && current.period === quote.period &&
      Number(current.extra_workstations) === quote.extraWorkstations && Number(current.remote_seats) === quote.remoteSeats) {
      return jsonError("That is the plan you have", 409, jsonHeaders);
    }
    try {
      const realCurrent = current && !current.id.startsWith("legacy:") ? current : null;
      const row = await startCheckout(env, db, {
        tenant,
        userId,
        quote,
        replaces: change.immediate ? null : realCurrent,
        startsAt: change.startsAt,
        upfront: change.upfront,
        now
      });
      return json({ url: row.short_url, subscription: subscriptionJson(row) }, jsonHeaders);
    } catch (err) {
      return refusal(err, jsonHeaders);
    }
  }

  if (path === "/api/billing/cancel" && method === "POST") {
    if (!isOwner) return jsonError("Only the organization's owner can cancel the subscription", 403, jsonHeaders);
    const body = (await readJson(request)) ?? {};
    const reason = typeof body.reason === "string" ? body.reason.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    try {
      const { endsAt } = await cancelSubscription(env, db, { tenant, userId, reason, now });
      await createNotification(db, {
        tenantId: tenant.id,
        kind: "license",
        title: "Subscription cancelled",
        body: `${tenant.name}'s subscription will not renew.${endsAt ? ` The plan stays until ${licenseDate(endsAt)}, then the organization moves to Free.` : ""} You can resume before then.`,
        createdBy: userId
      });
      await emailOwner(env, db, tenant, {
        subject: "Your Lab Kiosk subscription is cancelled",
        title: "Subscription cancelled",
        lead: `${tenant.name}'s subscription will not renew, and nothing more will be charged.`,
        details: endsAt ? [["Plan stays until", licenseDate(endsAt)]] : [],
        action: { label: "Resume", url: consoleUrl(ctx, tenant) },
        tone: "warning",
        text: "Changed your mind? Resume under Plan & billing before the date above and nothing is lost."
      });
      return json({ status: "ok", endsAt }, jsonHeaders);
    } catch (err) {
      return refusal(err, jsonHeaders);
    }
  }

  if (path === "/api/billing/resume" && method === "POST") {
    if (!isOwner) return jsonError("Only the organization's owner can resume the subscription", 403, jsonHeaders);
    if (!billingEnabled(env)) return jsonError("Online payment is not set up yet; contact sales", 503, jsonHeaders);
    const rows = await listSubscriptions(db, tenant.id);
    const cancelled = rows.find((r) => r.status === "cancelled" && r.cancel_reason !== "replaced" && (r.current_end ?? 0) > now);
    if (!cancelled) return jsonError("There is no cancelled subscription to resume", 409, jsonHeaders);
    try {
      const quote = quoteTier(quoteOf(cancelled), gstPercent);
      const row = await startCheckout(env, db, { tenant, userId, quote, replaces: cancelled, startsAt: cancelled.current_end, upfront: null, now });
      return json({ url: row.short_url, subscription: subscriptionJson(row) }, jsonHeaders);
    } catch (err) {
      return refusal(err, jsonHeaders);
    }
  }

  if (path === "/api/billing/refresh" && method === "POST") {
    if (!billingEnabled(env)) return json({ status: "ok", changed: false }, jsonHeaders);
    const rows = (await listSubscriptions(db, tenant.id, 5)).filter(
      (r) => r.razorpay_subscription_id && !isFinal(r.status) && r.updated_at < now - 10
    );
    let changed = false;
    try {
      for (const row of rows) {
        const result = await syncSubscription(env, db, row, now);
        if (result.granted || result.status !== row.status) {
          changed = true;
          await afterSubscriptionChange(env, db, row, result.status, result.granted, now);
        }
      }
    } catch (err) {
      return refusal(err, jsonHeaders);
    }
    return json({ status: "ok", changed }, jsonHeaders);
  }

  if (path === "/api/billing/details" && method === "POST") {
    const body = await readJson(request);
    if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
    const legalName = text(body.legalName, 200);
    const gstin = text(body.gstin, 15).toUpperCase().replace(/\s+/g, "");
    const address = text(body.address, 500);
    const state = text(body.state, 2);
    if (gstin && !validGstin(gstin)) return jsonError("That GSTIN is not valid: check the 15 characters", 400, jsonHeaders);
    if (state && !GST_STATES[state]) return jsonError("Choose the state from the list", 400, jsonHeaders);
    if (gstin && state && gstin.slice(0, 2) !== state) return jsonError("The GSTIN belongs to a different state than the one chosen", 400, jsonHeaders);
    await updateTenant(db, tenant.id, {
      billing_legal_name: legalName || null,
      billing_gstin: gstin || null,
      billing_address: address || null,
      billing_state: state || (gstin ? gstin.slice(0, 2) : null)
    });
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "billing.details", details: `gstin=${gstin ? "set" : "none"} state=${state || "-"}` });
    return json({ status: "ok" }, jsonHeaders);
  }

  if (path.startsWith("/api/billing/documents/") && method === "GET") {
    const match = /^\/api\/billing\/documents\/(invoice|proforma)\/([a-z0-9]{34})$/.exec(path);
    const kind = match?.[1] as DocumentKind | undefined;
    if (!match || !kind || !DOCUMENT_ID[kind].test(match[2])) return jsonError("Document not found", 404, jsonHeaders);
    return (await documentPage(ctx, tenant.id, kind, match[2])) ?? jsonError("Document not found", 404, jsonHeaders);
  }

  const invoiceMatch = /^\/api\/billing\/invoices\/(in[0-9a-f]{32})$/.exec(path);
  if (invoiceMatch && method === "GET") {
    const invoice = await findInvoice(db, tenant.id, invoiceMatch[1]);
    if (!invoice) return jsonError("Invoice not found", 404, jsonHeaders);
    const seller = sellerFrom(env);
    let lines: unknown = [];
    try {
      lines = JSON.parse(invoice.lines_json);
    } catch (err) {
      console.error(`[Billing] Invoice ${invoice.id} has unreadable lines:`, err);
    }
    return json(
      {
        ...invoiceJson(invoice),
        lines,
        razorpayPaymentId: invoice.razorpay_payment_id,
        buyer: { name: invoice.buyer_name, gstin: invoice.buyer_gstin, address: invoice.buyer_address },
        placeOfSupply: invoice.place_of_supply ? `${invoice.place_of_supply} ${GST_STATES[invoice.place_of_supply] ?? ""}`.trim() : null,
        seller: { name: seller.legalName, address: seller.address, gstin: invoice.seller_gstin, state: seller.state, sac: seller.sac }
      },
      jsonHeaders
    );
  }

  if (path === "/api/billing/remote-seats" && method === "POST") {
    const body = await readJson(request);
    const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
    if (!CLIENT_ID.test(clientId) || typeof body?.assigned !== "boolean") return jsonError("A workstation and assigned: true or false are required", 400, jsonHeaders);
    const result = await assignRemoteSeat(db, tenant.id, clientId, body.assigned, entitlement(tenant, now).remoteSeats, userId, now);
    if (!result.ok) return jsonError(result.error, result.status, jsonHeaders);
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "remote_control.seat", details: `client=${clientId} assigned=${body.assigned}` });
    return json({ status: "ok" }, jsonHeaders);
  }

  if (path === "/api/billing/staff" && method === "POST") {
    const staffDenied = await requireTenantPermission(db, session, tenant, "staff", jsonHeaders);
    if (staffDenied) return staffDenied;
    const body = await readJson(request);
    const target = typeof body?.userId === "string" ? body.userId : "";
    if (!USER_ID.test(target) || typeof body?.suspended !== "boolean") return jsonError("A staff member and suspended: true or false are required", 400, jsonHeaders);
    if (target === userId) return jsonError("You cannot suspend yourself", 400, jsonHeaders);
    const result = await setStaffSuspended(db, tenant, target, body.suspended, entitlement(tenant, now).staffLimit, now);
    if (!result.ok) return jsonError(result.error, result.status, jsonHeaders);
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: body.suspended ? "staff.suspend" : "staff.restore", details: `user=${target}` });
    return json({ status: "ok" }, jsonHeaders);
  }

  return jsonError("Not found", 404, jsonHeaders);
}

// ------------------------------------------------------------------- platform

async function platformBilling(ctx: BillingRouteContext): Promise<Response> {
  const { db, env, session, jsonHeaders, path, method, request } = ctx;
  const denied = requireSuperAdmin(session, jsonHeaders);
  if (denied) return denied;
  const userId = session!.user_id;
  const now = Math.floor(Date.now() / 1000);

  if (path === "/api/super/billing" && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT s.*, t.name AS tenant_name, t.subdomain AS tenant_subdomain
           FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
          WHERE s.status != 'expired'
          ORDER BY s.updated_at DESC
          LIMIT 500`
      )
      .all<SubscriptionRow & { tenant_name: string; tenant_subdomain: string }>();
    const rows = results ?? [];
    const paying = rows.filter((r) => r.status === "active" || r.status === "pending" || r.status === "halted");
    const mrr = paying.reduce((sum, r) => sum + (r.period === "month" ? Number(r.subtotal_paise) : Math.round(Number(r.subtotal_paise) / 12)), 0);
    const attention = await db
      .prepare(
        `SELECT e.event_id, e.event, e.entity_id, e.tenant_id, e.received_at, e.outcome, e.error, t.name AS tenant_name
           FROM billing_events e LEFT JOIN tenants t ON t.id = e.tenant_id
          WHERE e.outcome = 'amount_mismatch' OR (e.processed_at IS NULL AND e.received_at < ?)
          ORDER BY e.received_at DESC LIMIT 50`
      )
      .bind(now - 600)
      .all<Record<string, unknown>>();
    const failed30 = await db
      .prepare("SELECT COUNT(*) AS n FROM billing_events WHERE event IN ('subscription.pending', 'subscription.halted') AND received_at > ?")
      .bind(now - 30 * DAY)
      .first<{ n: number }>();
    return json(
      {
        enabled: billingEnabled(env),
        gstRegistered: Boolean(sellerFrom(env).gstin),
        tiles: {
          mrr,
          active: rows.filter((r) => r.status === "active").length,
          pastDue: rows.filter((r) => r.status === "pending" || r.status === "halted").length,
          cancelling: rows.filter((r) => r.status === "cancelled" && (r.current_end ?? 0) > now && r.cancel_reason !== "replaced").length,
          failedLast30Days: Number(failed30?.n ?? 0)
        },
        subscriptions: rows.map((r) => ({ ...subscriptionJson(r), tenantId: r.tenant_id, organization: r.tenant_name, subdomain: r.tenant_subdomain })),
        attention: attention.results ?? [],
        catalogue: catalogueJson(gstPercentFor(env))
      },
      jsonHeaders
    );
  }

  const detail = /^\/api\/super\/billing\/tenants\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (detail && method === "GET") {
    const tenant = await findTenantById(db, detail[1]);
    if (!tenant) return jsonError("Organization not found", 404, jsonHeaders);
    const events = await db
      .prepare(
        `SELECT event_id, event, entity_id, received_at, processed_at, outcome, error FROM billing_events
          WHERE tenant_id = ? OR entity_id IN (SELECT razorpay_subscription_id FROM subscriptions WHERE tenant_id = ?)
          ORDER BY received_at DESC LIMIT 100`
      )
      .bind(tenant.id, tenant.id)
      .all<Record<string, unknown>>();
    const payments = await db
      .prepare("SELECT id, kind, tier, period, total_paise, status, short_url, sent_to, created_at, paid_at, expires_at FROM payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50")
      .bind(tenant.id)
      .all<Record<string, unknown>>();
    const plan = entitlement(tenant, now);
    return json(
      {
        organization: { id: tenant.id, name: tenant.name, subdomain: tenant.subdomain },
        plan: { kind: plan.kind, label: plan.label, workstations: plan.limit, staff: plan.staffLimit, remoteSeats: plan.remoteSeats, expiresAt: plan.expiresAt, graceEndsAt: tenant.grace_ends_at ?? null },
        subscriptions: (await listSubscriptions(db, tenant.id, 50)).map(subscriptionJson),
        events: events.results ?? [],
        invoices: (await listInvoices(db, tenant.id, 100)).map(invoiceJson),
        proformas: await proformasJson(db, tenant.id),
        payments: payments.results ?? []
      },
      jsonHeaders
    );
  }

  if (path === "/api/super/billing/gstr1" && method === "GET") {
    const month = ctx.url.searchParams.get("month") || "";
    const section = (ctx.url.searchParams.get("section") || "") as Gstr1Section;
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || !GSTR1_SECTIONS.includes(section)) {
      return jsonError(`Give a month (YYYY-MM) and a section: ${GSTR1_SECTIONS.join(", ")}`, 400, jsonHeaders);
    }
    const csv = await gstr1Csv(env, db, month, section);
    await writeAuditLog(db, { userId, action: "billing.gstr1_export", details: `month=${month} section=${section}` });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="gstr1-${month}-${section}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }

  const body = method === "POST" ? await readJson(request) : null;
  if (method === "POST" && !body) return jsonError("The request body must be JSON", 400, jsonHeaders);

  if (path === "/api/super/billing/sync" && method === "POST") {
    const row = typeof body!.subscriptionId === "string" ? await findSubscription(db, body!.subscriptionId) : null;
    if (!row) return jsonError("Subscription not found", 404, jsonHeaders);
    try {
      const result = await syncSubscription(env, db, row, now);
      await afterSubscriptionChange(env, db, row, result.status, result.granted, now);
      await writeAuditLog(db, { tenantId: row.tenant_id, userId, action: "billing.sync", details: `subscription=${row.id} status=${result.status} granted=${result.granted}` });
      return json({ status: "ok", result }, jsonHeaders);
    } catch (err) {
      return refusal(err, jsonHeaders);
    }
  }

  if (path === "/api/super/billing/cancel" && method === "POST") {
    const row = typeof body!.subscriptionId === "string" ? await findSubscription(db, body!.subscriptionId) : null;
    if (!row) return jsonError("Subscription not found", 404, jsonHeaders);
    const tenant = await findTenantById(db, row.tenant_id);
    if (!tenant) return jsonError("Organization not found", 404, jsonHeaders);
    const immediately = body!.immediately === true;
    try {
      const rows = await listSubscriptions(db, tenant.id);
      if (currentSubscription(rows, now)?.id !== row.id && !isFinal(row.status)) {
        return jsonError("That is not the organization's current subscription; cancel it from its own row", 409, jsonHeaders);
      }
      if (!isFinal(row.status)) await cancelSubscription(env, db, { tenant, userId, reason: "cancelled by Lab Kiosk", now });
      if (immediately) {
        await updateTenant(db, tenant.id, { license_expires_at: now, grace_ends_at: null });
        await syncLicences(env, db, tenant.id, now * 1000);
      }
      await writeAuditLog(db, { tenantId: tenant.id, userId, action: "billing.platform_cancel", details: `subscription=${row.id} immediately=${immediately}` });
      return json({ status: "ok" }, jsonHeaders);
    } catch (err) {
      return refusal(err, jsonHeaders);
    }
  }

  if (path === "/api/super/billing/extend" && method === "POST") {
    const tenant = typeof body!.tenantId === "string" ? await findTenantById(db, body!.tenantId) : null;
    if (!tenant) return jsonError("Organization not found", 404, jsonHeaders);
    const days = body!.days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 366) return jsonError("Days must be a whole number from 1 to 366", 400, jsonHeaders);
    const plan = entitlement(tenant, now);
    if (plan.kind === "free") return jsonError("The organization is on Free: record a plan first", 409, jsonHeaders);
    const from = Math.max(plan.expiresAt ?? now, now);
    await updateTenant(db, tenant.id, { license_expires_at: from + days * DAY });
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "billing.extend", details: `days=${days} until=${licenseDate(from + days * DAY)}` });
    await createNotification(db, { tenantId: tenant.id, kind: "license", title: "Plan extended", body: `Lab Kiosk extended ${tenant.name}'s plan by ${days} days, to ${licenseDate(from + days * DAY)}.`, createdBy: userId });
    await syncLicences(env, db, tenant.id, now * 1000);
    return json({ status: "ok", expiresAt: from + days * DAY }, jsonHeaders);
  }

  if (path === "/api/super/billing/payment-link" && method === "POST") {
    if (!billingEnabled(env)) return jsonError("Razorpay is not set up", 503, jsonHeaders);
    const tenant = typeof body!.tenantId === "string" ? await findTenantById(db, body!.tenantId) : null;
    if (!tenant) return jsonError("Organization not found", 404, jsonHeaders);
    if (isDemoTenant(tenant, userId)) return jsonError("The platform's demo organizations are not billed", 400, jsonHeaders);
    const parsed = parseTierQuoteInput(body!);
    if (!parsed.ok) return jsonError(parsed.error, 400, jsonHeaders);
    const mode = body!.mode === "subscription" ? "subscription" : body!.mode === "once" ? "once" : null;
    if (!mode) return jsonError("Choose a one-off payment or a subscription", 400, jsonHeaders);
    const note = typeof body!.note === "string" ? body!.note.replace(/\r\n/g, "\n").trim().slice(0, 500) : "";
    const owner = tenant.user_id ? await findUserById(db, tenant.user_id) : null;
    if (!owner) return jsonError("The organization has no owner to send the link to", 409, jsonHeaders);
    const quote = quoteTier(parsed.value, gstPercentFor(env));
    let url: string | null;
    let proforma: Proforma | null = null;
    try {
      if (mode === "subscription") {
        const rows = await listSubscriptions(db, tenant.id);
        const current = await currentFor(db, tenant, rows, now);
        const change = planChange(current, quote, now, quote.gstPercent);
        const real = current && !current.id.startsWith("legacy:") ? current : null;
        const row = await startCheckout(env, db, { tenant, userId, quote, replaces: change.immediate ? null : real, startsAt: change.startsAt, upfront: change.upfront, now });
        url = row.short_url;
      } else {
        // A one-off payment is a proforma: a numbered document with the link and its QR code.
        proforma = await createProforma(env, db, {
          tenant,
          input: parsed.value,
          reason: "platform",
          validUntil: now + PLATFORM_LINK_HOURS * 3600,
          coversFrom: null,
          coversTo: null,
          userId,
          callbackUrl: `${ctx.url.origin}/api/billing/return`,
          note,
          now
        });
        const payment = await db.prepare("SELECT short_url FROM payments WHERE id = ?").bind(proforma.payment_id).first<{ short_url: string | null }>();
        url = payment?.short_url ?? null;
      }
    } catch (err) {
      if (err instanceof Error && !(err instanceof BillingRefusal) && !(err instanceof RazorpayError)) {
        return jsonError(err.message, 502, jsonHeaders);
      }
      return refusal(err, jsonHeaders);
    }
    if (!url) return jsonError("Razorpay did not return a link", 502, jsonHeaders);
    const planText = describePlan({ tier: quote.tier, period: quote.period, extra_workstations: quote.extraWorkstations, remote_seats: quote.remoteSeats });
    const emailed = proforma
      ? await emailDocument(env, db, tenant, "proforma", proforma.id, now, ctx.url.origin, {
          subject: `Proforma invoice ${proforma.number}: your Lab Kiosk ${CATALOGUE[quote.tier].label} plan`,
          title: "Your payment link",
          lead: `Lab Kiosk has prepared a payment for ${tenant.name}'s plan: ${planText}.`,
          text: `${note ? `${note}\n\n` : ""}The link is open for 7 days. Questions? Reply to this email.`
        })
      : await emailOwner(env, db, tenant, {
      subject: `Your Lab Kiosk ${CATALOGUE[quote.tier].label} plan: payment link`,
      title: mode === "subscription" ? "Set up your subscription" : "Your payment link",
      lead:
        mode === "subscription"
          ? `Lab Kiosk has prepared ${tenant.name}'s subscription. Authorise it once and it renews by itself; you can cancel any time.`
          : `Lab Kiosk has prepared a payment for ${tenant.name}'s plan.`,
      details: [
        ["Plan", describePlan({ tier: quote.tier, period: quote.period, extra_workstations: quote.extraWorkstations, remote_seats: quote.remoteSeats })],
        ["Amount", `${rupees(quote.total)}${quote.gst ? ` (GST ${rupees(quote.gst)})` : ""}${mode === "subscription" ? ` every ${quote.period}` : ""}`]
      ],
      action: { label: mode === "subscription" ? "Authorise subscription" : "Pay now", url },
      text: `${note ? `${note}\n\n` : ""}The link is open for ${mode === "subscription" ? "24 hours" : "7 days"}. Questions? Reply to this email.`
    });
    await writeAuditLog(db, {
      tenantId: tenant.id,
      userId,
      action: "billing.payment_link",
      details: `mode=${mode} tier=${quote.tier} period=${quote.period} total=${quote.total} emailed=${emailed}${proforma ? ` proforma=${proforma.number}` : ""}`
    });
    if (proforma && emailed) await db.prepare("UPDATE proformas SET emailed_at = ? WHERE id = ?").bind(now, proforma.id).run();
    return json({ status: "ok", url, emailed, proforma: proforma ? proforma.number : null }, jsonHeaders);
  }

  return jsonError("Not found", 404, jsonHeaders);
}

// ----------------------------------------------------------------------- cron

/** A week before a yearly renewal, the owner hears what will be charged, once per period. */
export async function sendRenewalNotices(env: Env, db: D1Database, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT * FROM subscriptions
        WHERE status = 'active' AND period = 'year' AND current_end BETWEEN ? AND ?
        LIMIT 100`
    )
    .bind(now + (RENEWAL_NOTICE_DAYS - 1) * DAY, now + RENEWAL_NOTICE_DAYS * DAY)
    .all<SubscriptionRow>();
  let sent = 0;
  for (const row of results ?? []) {
    const marker = await db
      .prepare("INSERT OR IGNORE INTO billing_events (event_id, event, entity_id, tenant_id, received_at, processed_at, outcome) VALUES (?, 'renewal_notice', ?, ?, ?, ?, 'sent')")
      .bind(`renewal:${row.id}:${row.current_end}`, row.id, row.tenant_id, now, now)
      .run();
    if (!marker.meta.changes) continue;
    const tenant = await findTenantById(db, row.tenant_id);
    if (!tenant) continue;
    const url = env.DEFAULT_DOMAIN ? `https://${tenant.subdomain}.${env.DEFAULT_DOMAIN}/admin/plan` : null;
    if (
      await emailOwner(env, db, tenant, {
        subject: "Your Lab Kiosk plan renews in a week",
        title: "Renewal in 7 days",
        lead: `${tenant.name}'s yearly plan renews on ${licenseDate(Number(row.current_end))}.`,
        details: [["Plan", describePlan(row)], ["Amount", rupees(Number(row.total_paise))]],
        action: url ? { label: "Review plan", url } : null,
        tone: "warning",
        text: "Nothing to do if this is right. To change or cancel, open Plan & billing before the renewal date."
      })
    ) {
      sent++;
    }
  }
  return sent;
}

