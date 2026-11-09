/**
 * Custom plans: the one thing the platform still decides by hand.
 *
 * An organization that needs more than the online plans offer (more than
 * PRICING.salesAbove workstations, many staff, terms of its own) asks for a
 * Custom plan from Plan & billing. A super admin reads the request under Tasks,
 * sets what the plan holds and its price, and approving it emails the
 * organization a Razorpay payment link for that price. When the link is paid,
 * recordPayment (src/billing.ts) applies the plan: a `commercial` licence with
 * the agreed workstations, staff and Remote Control seats until the end of the
 * period. A super admin may decline a request instead, with a reason.
 *
 *   GET  /api/plan/custom                       the organization's latest request
 *   POST /api/plan/custom                       ask for a Custom plan
 *   GET  /api/super/custom-plans                every request, open ones first
 *   POST /api/super/custom-plans/approve        set the plan and price, send the link
 *   POST /api/super/custom-plans/decline        {id, reason}
 */

import { billingEnabled, createPaymentLink, periodEnd, rupees } from "./billing";
import { findTenantById, findUserById, MAX_REMOTE_CONTROL_SEATS, MAX_WORKSTATION_LIMIT, updateTenant, writeAuditLog } from "./db";
import { jsonError, requireSuperAdmin, requireTenantPermission } from "./guard";
import { gstPercentFor } from "./invoices";
import { licenseDate } from "./license";
import { mailConfigProblem, sendMail } from "./mail";
import { createNotification } from "./notifications";
import { entitlement, STAFF_LIMITS, type BillingPeriod } from "./plans";
import { notifyPlatformOwner, type RouteContext } from "./signup";
import type { Tenant } from "./types";

export const CUSTOM_PLAN_LIMITS = {
  notes: 2000,
  reason: 1000,
  staff: 10_000,
  /** Rupees before GST: well above any real plan, and far inside a safe integer in paise. */
  price: 10_000_000,
  linkDays: { min: 1, max: 30, default: 7 }
} as const;

export type CustomPlanStatus = "open" | "sent" | "paid" | "declined";

export interface CustomPlanRequest {
  id: string;
  tenant_id: string;
  requested_by: string | null;
  workstations: number;
  remote_seats: number;
  staff: number | null;
  period: BillingPeriod;
  notes: string;
  status: CustomPlanStatus;
  subtotal_paise: number | null;
  gst_paise: number | null;
  total_paise: number | null;
  payment_id: string | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  created_at: number;
}

export interface CustomPlanRouteContext extends RouteContext {
  method: string;
  path: string;
  tenant: Tenant | null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function json(data: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}

interface PlanTerms {
  workstations: number;
  remoteSeats: number;
  /** Staff accounts besides the owner; null leaves the Custom default (STAFF_LIMITS.custom). */
  staff: number | null;
  period: BillingPeriod;
}

/** What a request or an approval says the plan holds. */
export function parsePlanTerms(body: Record<string, unknown>): Parsed<PlanTerms> {
  const workstations = wholeNumber(body.workstations, 1, MAX_WORKSTATION_LIMIT);
  if (workstations === null) return { ok: false, error: `Workstations: a whole number from 1 to ${MAX_WORKSTATION_LIMIT}` };
  const remoteSeats = body.remoteSeats === undefined || body.remoteSeats === null ? 0 : wholeNumber(body.remoteSeats, 0, MAX_REMOTE_CONTROL_SEATS);
  if (remoteSeats === null) return { ok: false, error: `Remote Control seats: a whole number from 0 to ${MAX_REMOTE_CONTROL_SEATS}` };
  if (remoteSeats > workstations) return { ok: false, error: "There cannot be more Remote Control seats than workstations" };
  const staff = body.staff === undefined || body.staff === null || body.staff === "" ? null : wholeNumber(body.staff, 1, CUSTOM_PLAN_LIMITS.staff);
  if (staff === null && body.staff !== undefined && body.staff !== null && body.staff !== "") {
    return { ok: false, error: `Staff accounts: a whole number from 1 to ${CUSTOM_PLAN_LIMITS.staff}` };
  }
  if (body.period !== "month" && body.period !== "year") return { ok: false, error: "Choose monthly or yearly billing" };
  return { ok: true, value: { workstations, remoteSeats, staff, period: body.period } };
}

/** One line for the plan: "Custom plan, 300 workstations, 20 Remote Control seats, 50 staff, yearly". */
export function describeCustomPlan(r: Pick<CustomPlanRequest, "workstations" | "remote_seats" | "staff" | "period">): string {
  return [
    "Custom plan",
    `${r.workstations} workstations`,
    ...(Number(r.remote_seats) ? [`${r.remote_seats} Remote Control seat${Number(r.remote_seats) === 1 ? "" : "s"}`] : []),
    `${r.staff ?? STAFF_LIMITS.custom} staff`,
    r.period === "year" ? "yearly" : "monthly"
  ].join(", ");
}

function requestJson(r: CustomPlanRequest) {
  return {
    id: r.id,
    workstations: Number(r.workstations),
    remoteSeats: Number(r.remote_seats),
    staff: r.staff === null ? null : Number(r.staff),
    period: r.period,
    notes: r.notes,
    status: r.status,
    total: r.total_paise === null ? null : rupees(Number(r.total_paise)),
    decisionNote: r.decision_note,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at === null ? null : Number(r.decided_at)
  };
}

export async function findCustomPlanRequest(db: D1Database, id: string): Promise<CustomPlanRequest | null> {
  return db.prepare("SELECT * FROM custom_plan_requests WHERE id = ?").bind(id).first<CustomPlanRequest>();
}

export async function customPlanForPayment(db: D1Database, paymentId: string): Promise<CustomPlanRequest | null> {
  return db.prepare("SELECT * FROM custom_plan_requests WHERE payment_id = ?").bind(paymentId).first<CustomPlanRequest>();
}

async function latestRequest(db: D1Database, tenantId: string): Promise<CustomPlanRequest | null> {
  return db
    .prepare("SELECT * FROM custom_plan_requests WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(tenantId)
    .first<CustomPlanRequest>();
}

/** How many requests wait for the platform: the Tasks badge. */
export async function openCustomPlanCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM custom_plan_requests WHERE status = 'open'").first<{ n: number }>();
  return Number(row?.n) || 0;
}

/**
 * The paid link's plan, applied once by recordPayment: a Custom (commercial)
 * licence from the end of a Custom plan still in force, otherwise from now.
 * Returns when it ends.
 */
export async function applyCustomPlan(db: D1Database, tenant: Tenant, request: CustomPlanRequest, nowSeconds: number): Promise<number> {
  const plan = entitlement(tenant, nowSeconds);
  const from = plan.kind === "custom" && plan.expiresAt !== null && plan.expiresAt > nowSeconds ? plan.expiresAt : nowSeconds;
  const ends = periodEnd(from, request.period);
  const seats = Number(request.remote_seats) || 0;
  await updateTenant(db, tenant.id, {
    license_plan: "commercial",
    plan_tier: null,
    license_expires_at: ends,
    workstation_limit: Number(request.workstations),
    staff_limit: request.staff === null ? null : Number(request.staff),
    remote_seats_paid: seats,
    remote_control_seats: Math.max(Number(tenant.remote_control_seats) || 1, seats),
    grace_ends_at: null
  });
  await db.prepare("UPDATE custom_plan_requests SET status = 'paid' WHERE id = ?").bind(request.id).run();
  return ends;
}

async function emailTo(ctx: RouteContext, to: { email: string; name: string }, subject: string, body: string, action?: { label: string; url: string }): Promise<boolean> {
  if (mailConfigProblem(ctx.env)) return false;
  try {
    await sendMail(ctx.env, {
      to: to.email,
      toName: to.name,
      subject,
      text: action ? `${body}\n\n${action.label}: ${action.url}` : body,
      template: { name: "notice", title: subject, ...(action ? { action } : {}) }
    });
    return true;
  } catch (err) {
    console.error(`[CustomPlan] Could not email ${to.email}:`, err);
    return false;
  }
}

export async function handleCustomPlanRoutes(ctx: CustomPlanRouteContext): Promise<Response | null> {
  if (ctx.path === "/api/plan/custom") return organizationRoutes(ctx);
  if (ctx.path === "/api/super/custom-plans" || ctx.path.startsWith("/api/super/custom-plans/")) return platformRoutes(ctx);
  return null;
}

// --------------------------------------------------------------- organization

async function organizationRoutes(ctx: CustomPlanRouteContext): Promise<Response> {
  const { db, session, jsonHeaders, method, request } = ctx;
  const denied = await requireTenantPermission(db, session, ctx.tenant, "settings", jsonHeaders);
  if (denied) return denied;
  const tenant = ctx.tenant!;

  if (method === "GET") {
    const latest = await latestRequest(db, tenant.id);
    return json({ request: latest ? requestJson(latest) : null }, jsonHeaders);
  }
  if (method !== "POST") return jsonError("Not found", 404, jsonHeaders);
  if (!tenant.profile_completed_at) return jsonError("Enter your organization's details in the console first", 409, jsonHeaders);
  if (session!.role === "super_admin") return jsonError("The platform's demo organizations are not billed", 400, jsonHeaders);

  const body = await readJson(request);
  if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
  const terms = parsePlanTerms(body);
  if (!terms.ok) return jsonError(terms.error, 400, jsonHeaders);
  const notes = text(body.notes, CUSTOM_PLAN_LIMITS.notes);
  const latest = await latestRequest(db, tenant.id);
  if (latest && (latest.status === "open" || latest.status === "sent")) {
    return jsonError(
      latest.status === "open" ? "Your Custom plan request is already with Lab Kiosk" : "Lab Kiosk has sent you a payment link for your Custom plan; pay it or write to support",
      409,
      jsonHeaders
    );
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const t = terms.value;
  await db
    .prepare(
      `INSERT INTO custom_plan_requests (id, tenant_id, requested_by, workstations, remote_seats, staff, period, notes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    )
    .bind(id, tenant.id, session!.user_id, t.workstations, t.remoteSeats, t.staff, t.period, notes, now)
    .run();
  await writeAuditLog(db, {
    tenantId: tenant.id,
    userId: session!.user_id,
    action: "plan.custom_request",
    details: `request=${id} workstations=${t.workstations} seats=${t.remoteSeats} staff=${t.staff ?? "default"} period=${t.period}`
  });
  const requester = await findUserById(db, session!.user_id);
  const summary = describeCustomPlan({ workstations: t.workstations, remote_seats: t.remoteSeats, staff: t.staff, period: t.period });
  if (requester) {
    await emailTo(
      ctx,
      { email: requester.email, name: requester.name },
      "We received your Custom plan request",
      `Hello ${requester.name},\n\nLab Kiosk has your request for ${tenant.name}: ${summary}.${notes ? `\n\nYour notes:\n${notes}` : ""}\n\n` +
        "We will email you a payment link with the price, usually within two working days. The plan starts as soon as it is paid.\n\nLab Kiosk"
    );
  }
  await notifyPlatformOwner(
    ctx.env,
    `Custom plan requested: ${tenant.name}`,
    `${requester ? `${requester.name} <${requester.email}>` : "An administrator"} asked for a Custom plan for ${tenant.name} (${tenant.subdomain}): ${summary}.` +
      (notes ? `\n\n${notes}` : "") +
      "\n\nSet the price and send the payment link under Tasks, Custom plans, in the Super Admin console."
  );
  const created = (await findCustomPlanRequest(db, id))!;
  return json({ status: "ok", request: requestJson(created) }, jsonHeaders);
}

// ------------------------------------------------------------------- platform

async function platformRoutes(ctx: CustomPlanRouteContext): Promise<Response> {
  const { db, env, session, jsonHeaders, path, method, request } = ctx;
  const denied = requireSuperAdmin(session, jsonHeaders);
  if (denied) return denied;
  const userId = session!.user_id;

  if (path === "/api/super/custom-plans" && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT r.*, t.name AS tenant_name, t.subdomain AS tenant_subdomain, u.name AS requester_name, u.email AS requester_email
           FROM custom_plan_requests r
           JOIN tenants t ON t.id = r.tenant_id
           LEFT JOIN users u ON u.id = r.requested_by
          ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END, r.created_at DESC
          LIMIT 200`
      )
      .all<CustomPlanRequest & { tenant_name: string; tenant_subdomain: string; requester_name: string | null; requester_email: string | null }>();
    return json(
      {
        requests: (results ?? []).map((r) => ({
          ...requestJson(r),
          organization: r.tenant_name,
          subdomain: r.tenant_subdomain,
          requester: r.requester_email ? { name: r.requester_name, email: r.requester_email } : null
        })),
        billingEnabled: billingEnabled(env),
        gstPercent: gstPercentFor(env)
      },
      jsonHeaders
    );
  }

  if (method !== "POST" || (path !== "/api/super/custom-plans/approve" && path !== "/api/super/custom-plans/decline")) {
    return jsonError("Not found", 404, jsonHeaders);
  }
  const body = await readJson(request);
  if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
  const found = typeof body.id === "string" ? await findCustomPlanRequest(db, body.id) : null;
  if (!found) return jsonError("Request not found", 404, jsonHeaders);
  if (found.status !== "open") return jsonError("This request has already been decided", 409, jsonHeaders);
  const tenant = await findTenantById(db, found.tenant_id);
  if (!tenant) return jsonError("The organization no longer exists", 404, jsonHeaders);
  const owner = tenant.user_id ? await findUserById(db, tenant.user_id) : null;
  const now = Math.floor(Date.now() / 1000);

  if (path === "/api/super/custom-plans/decline") {
    const reason = text(body.reason, CUSTOM_PLAN_LIMITS.reason);
    if (!reason) return jsonError("Say why, for the organization", 400, jsonHeaders);
    const claimed = await db
      .prepare("UPDATE custom_plan_requests SET status = 'declined', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'open'")
      .bind(userId, now, reason, found.id)
      .run();
    if (!claimed.meta.changes) return jsonError("This request has already been decided", 409, jsonHeaders);
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "plan.custom_decline", details: `request=${found.id}` });
    await createNotification(db, {
      tenantId: tenant.id,
      kind: "license",
      title: "Custom plan request declined",
      body: `Lab Kiosk could not offer ${tenant.name} the Custom plan it asked for.\n\n${reason}`,
      createdBy: userId
    });
    const emailed = owner
      ? await emailTo(ctx, { email: owner.email, name: owner.name }, "About your Custom plan request", `Hello ${owner.name},\n\nLab Kiosk could not offer ${tenant.name} the Custom plan it asked for.\n\n${reason}\n\nReply to this email to talk it over.\n\nLab Kiosk`)
      : false;
    return json({ status: "ok", emailed }, jsonHeaders);
  }

  // Approve: the plan as agreed (the request's terms unless changed), its price, and the link.
  if (!billingEnabled(env)) return jsonError("Razorpay is not set up", 503, jsonHeaders);
  if (!owner) return jsonError("The organization has no owner to send the link to", 409, jsonHeaders);
  const terms = parsePlanTerms({
    workstations: body.workstations ?? Number(found.workstations),
    remoteSeats: body.remoteSeats ?? Number(found.remote_seats),
    staff: body.staff === undefined ? found.staff : body.staff,
    period: body.period ?? found.period
  });
  if (!terms.ok) return jsonError(terms.error, 400, jsonHeaders);
  const price = wholeNumber(body.price, 1, CUSTOM_PLAN_LIMITS.price);
  if (price === null) return jsonError(`Price: whole rupees before GST, from 1 to ${CUSTOM_PLAN_LIMITS.price}`, 400, jsonHeaders);
  const days =
    body.validDays === undefined ? CUSTOM_PLAN_LIMITS.linkDays.default : wholeNumber(body.validDays, CUSTOM_PLAN_LIMITS.linkDays.min, CUSTOM_PLAN_LIMITS.linkDays.max);
  if (days === null) return jsonError(`The link is open for ${CUSTOM_PLAN_LIMITS.linkDays.min} to ${CUSTOM_PLAN_LIMITS.linkDays.max} days`, 400, jsonHeaders);
  const note = text(body.note, CUSTOM_PLAN_LIMITS.reason);

  const t = terms.value;
  const subtotal = price * 100;
  const gst = Math.round((subtotal * gstPercentFor(env)) / 100);
  const total = subtotal + gst;
  // Claimed before the link is made, so two approvals of one request cannot both send one.
  const claimed = await db
    .prepare(
      `UPDATE custom_plan_requests
          SET status = 'sent', workstations = ?, remote_seats = ?, staff = ?, period = ?, subtotal_paise = ?, gst_paise = ?, total_paise = ?,
              decided_by = ?, decided_at = ?, decision_note = ?
        WHERE id = ? AND status = 'open'`
    )
    .bind(t.workstations, t.remoteSeats, t.staff, t.period, subtotal, gst, total, userId, now, note || null, found.id)
    .run();
  if (!claimed.meta.changes) return jsonError("This request has already been decided", 409, jsonHeaders);
  const summary = describeCustomPlan({ workstations: t.workstations, remote_seats: t.remoteSeats, staff: t.staff, period: t.period });
  let url: string;
  try {
    const payment = await createPaymentLink(env, db, {
      tenantId: tenant.id,
      organization: tenant.name,
      userId,
      email: owner.email,
      name: owner.name,
      quote: { period: t.period, extraWorkstations: 0, workstations: t.workstations, subtotal, gst, total },
      callbackUrl: `${ctx.url.origin}/api/billing/return`,
      nowSeconds: now,
      platform: { tier: null, label: "Custom plan", remoteSeats: t.remoteSeats, note, hours: days * 24, razorpayEmail: false }
    });
    if (!payment.short_url) throw new Error("Razorpay did not return a link");
    url = payment.short_url;
    await db.prepare("UPDATE custom_plan_requests SET payment_id = ? WHERE id = ?").bind(payment.id, found.id).run();
  } catch (err) {
    // Nothing was sent: the request goes back to waiting, as it was.
    await db
      .prepare(
        "UPDATE custom_plan_requests SET status = 'open', subtotal_paise = NULL, gst_paise = NULL, total_paise = NULL, decided_by = NULL, decided_at = NULL, decision_note = NULL WHERE id = ?"
      )
      .bind(found.id)
      .run();
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CustomPlan] The payment link was not created:", message);
    return jsonError(message, 502, jsonHeaders);
  }
  await writeAuditLog(db, {
    tenantId: tenant.id,
    userId,
    action: "plan.custom_approve",
    details: `request=${found.id} total=${total} workstations=${t.workstations} seats=${t.remoteSeats} staff=${t.staff ?? "default"} period=${t.period}`
  });
  await createNotification(db, {
    tenantId: tenant.id,
    kind: "license",
    title: "Your Custom plan is ready to pay",
    body: `Lab Kiosk has approved ${tenant.name}'s Custom plan: ${summary}, ${rupees(total)}. The payment link was emailed to ${owner.email}; the plan starts when it is paid.`,
    createdBy: userId
  });
  const emailed = await emailTo(
    ctx,
    { email: owner.email, name: owner.name },
    "Your Custom plan: payment link",
    `Hello ${owner.name},\n\nLab Kiosk has approved ${tenant.name}'s Custom plan: ${summary}.\n\n` +
      `Price: ${rupees(subtotal)}${gst ? ` + GST ${rupees(gst)} = ${rupees(total)}` : ""}${t.period === "year" ? " a year" : " a month"}.` +
      `${note ? `\n\n${note}` : ""}\n\nThe link is open for ${days} day${days === 1 ? "" : "s"}. The plan starts as soon as it is paid, ` +
      `and runs ${t.period === "year" ? "a year" : "a month"}; renewing is a new link.\n\nLab Kiosk`,
    { label: "Pay now", url }
  );
  return json({ status: "ok", url, emailed, total: rupees(total) }, jsonHeaders);
}

/** The plan line for a paid Custom link's notification and invoice email. */
export function customPlanPaidText(request: CustomPlanRequest, ends: number): string {
  return `${describeCustomPlan(request)}, until ${licenseDate(ends)}`;
}
