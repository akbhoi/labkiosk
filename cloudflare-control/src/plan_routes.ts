/**
 * The routes behind Plan in an organization's console and the platform's
 * review of education applications (src/plans.ts, src/education.ts,
 * src/billing.ts). handlePlanRoutes answers a request it owns and returns null
 * for any other.
 *
 * Organization (the `settings` permission):
 *   GET  /api/plan                      the plan, prices, trial, application, workstations, payments
 *   POST /api/plan/trial                start the one free trial
 *   POST /api/plan/education            apply (multipart, with the certificate); emails a code
 *   POST /api/plan/education/verify     {id, code}: confirm the address; the platform reviews it
 *   POST /api/plan/checkout             {period, extraWorkstations}: a Razorpay payment link
 *   POST /api/plan/licence              {clientId}: move a licence to a workstation showing the notice
 * Razorpay (no session):
 *   GET  /api/billing/return            the payer's way back, signed
 *   POST /api/billing/razorpay/webhook  payment_link.paid, signed
 * Custom plans (src/custom_plans.ts): /api/plan/custom and /api/super/custom-plans/*.
 * Platform:
 *   GET  /api/super/education                       applications
 *   GET  /api/super/education/:id/certificate       the certificate
 *   POST /api/super/education/decide {id, decision, reason}
 */

import {
  billingEnabled,
  createPaymentLink,
  listPayments,
  paidLinkFromWebhook,
  recordPayment,
  rupees,
  verifyReturnSignature,
  verifyWebhookSignature,
  type Payment
} from "./billing";
import { customPlanForPayment, customPlanPaidText, describeCustomPlan, handleCustomPlanRoutes } from "./custom_plans";
import { findTenantById, findUserById, rateLimitWait, recordRateLimitHit, updateTenant, writeAuditLog } from "./db";
import {
  applicationJson,
  confirmApplicationEmail,
  decideApplication,
  EDUCATION_LIMITS,
  findApplication,
  latestApplication,
  listApplicationsForReview,
  parseEducationForm,
  readCertificate,
  startApplication
} from "./education";
import { jsonError, requireSuperAdmin, requireTenantPermission } from "./guard";
import { licenseDate } from "./license";
import { sendMail, mailConfigProblem } from "./mail";
import { createNotification, notifyOwner } from "./notifications";
import { moveLicence, syncLicences } from "./plan_sync";
import { afterSubscriptionChange, describePlan } from "./billing_routes";
import { emailPaidInvoice } from "./billing_documents";
import { CATALOGUE, entitlement, listEnrolledWorkstations, MAX_ONLINE_EXTRA, parseQuoteInput, PRICING, trialRefusal } from "./plans";
import { findSubscriptionByRazorpayId, syncSubscription } from "./subscriptions";
import { notifyPlatformOwner, type RouteContext } from "./signup";
import type { Tenant } from "./types";

const DAY = 86_400;
/** Education applications (and so emailed codes) an organization may send per hour. */
const EDUCATION_RATE_LIMIT = { limit: 5, windowSeconds: 3600 };

export interface PlanRouteContext extends RouteContext {
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
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function paymentJson(p: Payment) {
  return {
    id: p.id,
    period: p.period,
    workstations: PRICING.includedWorkstations + Number(p.extra_workstations),
    total: rupees(Number(p.total_paise)),
    paidAt: p.paid_at === null ? null : Number(p.paid_at),
    endsAt: p.period_ends_at === null ? null : Number(p.period_ends_at),
    paymentId: p.razorpay_payment_id
  };
}

function planUrl(ctx: PlanRouteContext, subdomain: string, query: string): string {
  return ctx.isDev
    ? `${ctx.url.origin}/admin/plan?tenant=${encodeURIComponent(subdomain)}&${query}`
    : `https://${subdomain}.${ctx.baseDomain}/admin/plan?${query}`;
}

/** Best effort: the organization's owner hears about a decision by email too. */
async function emailOwner(ctx: PlanRouteContext, tenant: Tenant, subject: string, text: string): Promise<boolean> {
  if (mailConfigProblem(ctx.env)) return false;
  const owner = tenant.user_id ? await findUserById(ctx.db, tenant.user_id) : null;
  if (!owner) return false;
  try {
    await sendMail(ctx.env, { to: owner.email, toName: owner.name, subject, text, template: { name: "notice", title: subject } });
    return true;
  } catch (err) {
    console.error(`[Plan] Could not email the owner of ${tenant.id}:`, err);
    return false;
  }
}

export async function handlePlanRoutes(ctx: PlanRouteContext): Promise<Response | null> {
  const { path, method } = ctx;
  if (path === "/api/billing/return" && method === "GET") return billingReturn(ctx);
  if (path === "/api/billing/razorpay/webhook" && method === "POST") return billingWebhook(ctx);
  if (path === "/api/super/education" || path.startsWith("/api/super/education/")) return superEducation(ctx);
  const custom = await handleCustomPlanRoutes(ctx);
  if (custom) return custom;
  if (path === "/api/plan" || path.startsWith("/api/plan/")) return organizationPlan(ctx);
  return null;
}

// --------------------------------------------------------------- organization

async function organizationPlan(ctx: PlanRouteContext): Promise<Response | null> {
  const { db, env, session, jsonHeaders, path, method, request } = ctx;
  const denied = await requireTenantPermission(db, session, ctx.tenant, "settings", jsonHeaders);
  if (denied) return denied;
  const tenant = ctx.tenant!;
  // Plans are bought for an organization whose name and address are entered:
  // invoices carry them, and the place of supply comes from the state.
  if (!tenant.profile_completed_at && method !== "GET") {
    return jsonError("Enter your organization's details in the console first", 409, jsonHeaders);
  }
  const userId = session!.user_id;
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);

  if (path === "/api/plan" && method === "GET") {
    const [application, workstations, payments] = await Promise.all([
      latestApplication(db, tenant.id),
      listEnrolledWorkstations(db, tenant.id),
      listPayments(db, tenant.id)
    ]);
    const plan = entitlement(tenant, now);
    return json(
      {
        plan,
        pricing: PRICING,
        maxOnlineExtra: MAX_ONLINE_EXTRA,
        trial: { refusal: trialRefusal(tenant, now), startedAt: tenant.trial_started_at ?? null },
        education: application ? applicationJson(application) : null,
        workstations: workstations.sort((a, b) => Number(a.licensed) - Number(b.licensed) || b.lastSeen - a.lastSeen),
        online: billingEnabled(env),
        payments: payments.map(paymentJson),
        now
      },
      jsonHeaders
    );
  }

  if (path === "/api/plan/trial" && method === "POST") {
    const refusal = trialRefusal(tenant, now);
    if (refusal) return jsonError(refusal, 409, jsonHeaders);
    const ends = now + PRICING.trialDays * DAY;
    await updateTenant(db, tenant.id, {
      license_plan: "evaluation",
      license_expires_at: ends,
      workstation_limit: Math.max(PRICING.includedWorkstations, Number(tenant.workstation_limit) || 0),
      trial_started_at: now
    });
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "plan.trial", details: `ends=${licenseDate(ends)}` });
    await notifyOwner(env, db, {
      tenantId: tenant.id,
      kind: "license",
      title: "Free trial started",
      body: `${tenant.name} can use ${PRICING.includedWorkstations} workstations until ${licenseDate(ends)}. Subscribe under Plan before then to keep them.`,
      createdBy: userId
    });
    await syncLicences(env, db, tenant.id, nowMs);
    return json({ status: "ok", endsAt: ends }, jsonHeaders);
  }

  if (path === "/api/plan/education" && method === "POST") {
    const key = `education:${tenant.id}`;
    const wait = await rateLimitWait(db, key, EDUCATION_RATE_LIMIT.limit, EDUCATION_RATE_LIMIT.windowSeconds);
    if (wait > 0) return jsonError(`Too many applications. Try again in ${Math.ceil(wait / 60)} minutes.`, 429, jsonHeaders);
    const problem = mailConfigProblem(env);
    if (problem) return jsonError(`The confirmation code cannot be emailed: ${problem}`, 503, jsonHeaders);
    const length = Number(request.headers.get("content-length") || 0);
    if (length > EDUCATION_LIMITS.certificateBytes + 64 * 1024) return jsonError("The certificate must be 5 MB or smaller", 413, jsonHeaders);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonError("Send the application as a form with the certificate attached", 400, jsonHeaders);
    }
    const parsed = await parseEducationForm(form);
    if (!parsed.ok) return jsonError(parsed.error, 400, jsonHeaders);
    const started = await startApplication(env, db, tenant.id, userId, parsed.value, now);
    if (!started.ok) return jsonError(started.error, started.status, jsonHeaders);
    await recordRateLimitHit(db, key, EDUCATION_RATE_LIMIT.windowSeconds);
    try {
      await sendMail(env, {
        to: parsed.value.email,
        subject: `Your Lab Kiosk code: ${started.code}`,
        text:
          `${started.code} is the code that confirms ${parsed.value.email} for the Education application of ${parsed.value.institution} on Lab Kiosk.\n\n` +
          `Enter it under Plan in the console within ${EDUCATION_LIMITS.codeMinutes} minutes. If you did not apply, ignore this email.`,
        template: { name: "notice", title: "Confirm your institution's address" }
      });
    } catch (err) {
      console.error(`[Plan] Could not email the education code for ${tenant.id}:`, err);
      return jsonError("The code could not be emailed to that address. Check it and try again.", 502, jsonHeaders);
    }
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "plan.education_apply", details: `application=${started.application.id} email=${parsed.value.email}` });
    return json({ status: "ok", application: applicationJson(started.application) }, jsonHeaders);
  }

  if (path === "/api/plan/education/verify" && method === "POST") {
    const body = await readJson(request);
    if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
    const confirmed = await confirmApplicationEmail(db, tenant.id, String(body.id ?? ""), String(body.code ?? "").trim(), now);
    if (!confirmed.ok) return jsonError(confirmed.error, confirmed.status, jsonHeaders);
    const a = confirmed.application;
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "plan.education_submit", details: `application=${a.id}` });
    await notifyPlatformOwner(
      env,
      `Education application: ${a.institution}`,
      `${tenant.name} (${tenant.subdomain}) applied for the Education plan.\n\nInstitution: ${a.institution}\nBoard: ${a.board}\n` +
        `Affiliation number: ${a.affiliation_number}\nWebsite: ${a.website}\nConfirmed address: ${a.email}\n\n` +
        "Read the certificate and decide in Super Admin -> Organizations -> Education applications."
    );
    return json({ status: "ok", application: applicationJson(a) }, jsonHeaders);
  }

  if (path === "/api/plan/checkout" && method === "POST") {
    const body = await readJson(request);
    if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
    const parsed = parseQuoteInput(body);
    if (!parsed.ok) return jsonError(parsed.error, 400, jsonHeaders);
    if (!billingEnabled(env)) {
      return json({ error: "Online payment is not available yet. Contact sales to subscribe.", contactSales: true }, jsonHeaders, 503);
    }
    const user = await findUserById(db, userId);
    if (!user) return jsonError("Your account was not found", 401, jsonHeaders);
    try {
      const payment = await createPaymentLink(env, db, {
        tenantId: tenant.id,
        organization: tenant.name,
        userId,
        email: user.email,
        name: user.name || tenant.name,
        quote: parsed.value,
        callbackUrl: `${ctx.url.origin}/api/billing/return`,
        nowSeconds: now
      });
      await writeAuditLog(db, {
        tenantId: tenant.id,
        userId,
        action: "plan.checkout",
        details: `payment=${payment.id} period=${payment.period} extra=${payment.extra_workstations} total=${payment.total_paise}`
      });
      return json({ status: "ok", url: payment.short_url }, jsonHeaders);
    } catch (err) {
      console.error(`[Plan] Payment link for ${tenant.id} failed:`, err);
      return jsonError(err instanceof Error ? err.message : "The payment link could not be created", 502, jsonHeaders);
    }
  }

  if (path === "/api/plan/licence" && method === "POST") {
    const body = await readJson(request);
    if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
    const clientId = String(body.clientId ?? "").trim();
    if (!clientId) return jsonError("Name the workstation", 400, jsonHeaders);
    const moved = await moveLicence(env, db, tenant.id, clientId, nowMs);
    if (!moved.ok) return jsonError(moved.error, moved.status, jsonHeaders);
    await writeAuditLog(db, { tenantId: tenant.id, userId, action: "plan.licence_move", details: `to=${clientId} from=${moved.displaced ?? "free place"}` });
    return json({ status: "ok", displaced: moved.displaced }, jsonHeaders);
  }

  return jsonError("Not found", 404, jsonHeaders);
}

// ------------------------------------------------------------------ Razorpay

async function activate(ctx: PlanRouteContext, ref: { referenceId: string; linkId: string; paymentId: string }, via: string): Promise<Payment | null> {
  const nowMs = Date.now();
  const payment = await recordPayment(ctx.db, ref, Math.floor(nowMs / 1000), ctx.env);
  if (!payment) return null;
  const tenant = await findTenantById(ctx.db, payment.tenant_id);
  await writeAuditLog(ctx.db, {
    tenantId: payment.tenant_id,
    action: "plan.paid",
    details: `payment=${payment.id} razorpay=${payment.razorpay_payment_id} via=${via} total=${payment.total_paise} ends=${payment.period_ends_at ? licenseDate(Number(payment.period_ends_at)) : "-"}`
  });
  const custom = await customPlanForPayment(ctx.db, payment.id);
  if (tenant && custom) {
    const ends = Number(payment.period_ends_at);
    await createNotification(ctx.db, {
      tenantId: tenant.id,
      kind: "license",
      title: "Payment received",
      body: `Thank you. ${tenant.name} is on its ${customPlanPaidText(custom, ends)} (paid ${rupees(Number(payment.total_paise))}).`,
      createdBy: payment.created_by
    });
    await syncLicences(ctx.env, ctx.db, tenant.id, nowMs);
    await emailPaidInvoice(ctx.env, ctx.db, tenant, payment.id, Math.floor(nowMs / 1000), ctx.url.origin, {
      plan: describeCustomPlan(custom),
      paidUntil: licenseDate(ends)
    });
  } else if (tenant) {
    await createNotification(ctx.db, {
      tenantId: tenant.id,
      kind: "license",
      title: "Payment received",
      body: `Thank you. ${tenant.name} is subscribed for ${CATALOGUE[payment.tier ?? "standard"].includedWorkstations + Number(payment.extra_workstations)} workstations${payment.period_ends_at ? ` until ${licenseDate(Number(payment.period_ends_at))}` : ""} (paid ${rupees(Number(payment.total_paise))}).`,
      createdBy: payment.created_by
    });
    await syncLicences(ctx.env, ctx.db, tenant.id, nowMs);
    const plan = describePlan({
      tier: payment.tier ?? "standard",
      period: payment.period,
      extra_workstations: Number(payment.extra_workstations),
      remote_seats: Number(payment.remote_seats) || 0,
      custom_domain: Number(payment.custom_domain) === 1 ? 1 : 0
    });
    await emailPaidInvoice(ctx.env, ctx.db, tenant, payment.id, Math.floor(nowMs / 1000), ctx.url.origin, {
      plan,
      paidUntil: payment.period_ends_at ? licenseDate(Number(payment.period_ends_at)) : null
    });
  }
  return payment;
}

async function billingReturn(ctx: PlanRouteContext): Promise<Response> {
  const q = ctx.url.searchParams;
  const ref = {
    linkId: q.get("razorpay_payment_link_id") || "",
    referenceId: q.get("razorpay_payment_link_reference_id") || "",
    status: q.get("razorpay_payment_link_status") || "",
    paymentId: q.get("razorpay_payment_id") || "",
    signature: q.get("razorpay_signature") || ""
  };
  const payment = ref.referenceId ? await findPaymentTenant(ctx.db, ref.referenceId) : null;
  if (!payment) return jsonError("This payment is not known", 404, ctx.jsonHeaders);
  const secret = ctx.env.RAZORPAY_KEY_SECRET;
  const signed = Boolean(secret) && (await verifyReturnSignature(secret!, ref));
  if (!signed) {
    console.warn(`[Billing] A return for payment ${ref.referenceId} carried a signature that does not verify`);
    return Response.redirect(planUrl(ctx, payment.subdomain, "payment=unverified"), 302);
  }
  if (ref.status !== "paid") return Response.redirect(planUrl(ctx, payment.subdomain, "payment=cancelled"), 302);
  await activate(ctx, ref, "return");
  return Response.redirect(planUrl(ctx, payment.subdomain, "payment=paid"), 302);
}

async function findPaymentTenant(db: D1Database, id: string): Promise<{ subdomain: string } | null> {
  return db
    .prepare("SELECT t.subdomain AS subdomain FROM payments p JOIN tenants t ON t.id = p.tenant_id WHERE p.id = ?")
    .bind(id)
    .first<{ subdomain: string }>();
}

/**
 * Razorpay's webhook. The signature is checked on the raw body; each event id
 * is processed once (billing_events). A subscription event only prompts a
 * fresh look at that subscription through Razorpay's API, whose state is
 * what is applied (src/subscriptions.ts), so order and repeats do not matter.
 * When Razorpay cannot be read, the answer is 500 and Razorpay sends the
 * event again; the hourly reconciliation is the second net.
 */
async function billingWebhook(ctx: PlanRouteContext): Promise<Response> {
  const secret = ctx.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return jsonError("The webhook is not set up", 503, ctx.jsonHeaders);
  const raw = await ctx.request.text();
  if (!(await verifyWebhookSignature(secret, raw, ctx.request.headers.get("x-razorpay-signature") || ""))) {
    return jsonError("The signature does not verify", 401, ctx.jsonHeaders);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("The body is not JSON", 400, ctx.jsonHeaders);
  }
  const now = Math.floor(Date.now() / 1000);
  const event = typeof (body as { event?: unknown })?.event === "string" ? String((body as { event: string }).event).slice(0, 64) : "";
  const subscriptionId = subscriptionIdFromWebhook(body);
  // Razorpay names each event; a signed body without the header still gets a stable id.
  const eventId = (ctx.request.headers.get("x-razorpay-event-id") || "").slice(0, 100) || `sha:${await sha256Hex(raw)}`;
  const seen = await ctx.db
    .prepare("SELECT processed_at FROM billing_events WHERE event_id = ?")
    .bind(eventId)
    .first<{ processed_at: number | null }>();
  if (seen?.processed_at) return json({ status: "ok", duplicate: true }, ctx.jsonHeaders);
  if (!seen) {
    await ctx.db
      .prepare("INSERT OR IGNORE INTO billing_events (event_id, event, entity_id, received_at) VALUES (?, ?, ?, ?)")
      .bind(eventId, event, subscriptionId ?? paidLinkFromWebhook(body)?.referenceId ?? null, now)
      .run();
  }
  let outcome = "ignored";
  let tenantId: string | null = null;
  try {
    const paid = paidLinkFromWebhook(body);
    if (paid) {
      const payment = await activate(ctx, paid, "webhook");
      outcome = payment ? "payment_recorded" : "payment_known";
      tenantId = payment?.tenant_id ?? null;
    } else if (subscriptionId && event.startsWith("subscription.")) {
      const row = await findSubscriptionByRazorpayId(ctx.db, subscriptionId);
      if (!row) {
        outcome = "unknown_subscription";
      } else {
        tenantId = row.tenant_id;
        const result = await syncSubscription(ctx.env, ctx.db, row, now);
        outcome = result.mismatched.length ? "amount_mismatch" : `synced:${result.status}${result.granted ? `:granted${result.granted}` : ""}`;
        await afterSubscriptionChange(ctx.env, ctx.db, row, result.status, result.granted, now);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Billing] Webhook ${event} (${eventId}) failed:`, message);
    await ctx.db.prepare("UPDATE billing_events SET error = ? WHERE event_id = ?").bind(message.slice(0, 500), eventId).run();
    return jsonError("The event could not be applied yet", 500, ctx.jsonHeaders);
  }
  await ctx.db
    .prepare("UPDATE billing_events SET processed_at = ?, outcome = ?, tenant_id = COALESCE(tenant_id, ?), error = NULL WHERE event_id = ?")
    .bind(now, outcome, tenantId, eventId)
    .run();
  return json({ status: "ok" }, ctx.jsonHeaders);
}

function subscriptionIdFromWebhook(body: unknown): string | null {
  const id = (body as { payload?: { subscription?: { entity?: { id?: unknown } } } })?.payload?.subscription?.entity?.id;
  return typeof id === "string" && /^sub_[A-Za-z0-9]{1,32}$/.test(id) ? id : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------- platform

async function superEducation(ctx: PlanRouteContext): Promise<Response> {
  const { db, env, session, jsonHeaders, path, method, request } = ctx;
  const denied = requireSuperAdmin(session, jsonHeaders);
  if (denied) return denied;
  const userId = session!.user_id;

  if (path === "/api/super/education" && method === "GET") {
    const list = await listApplicationsForReview(db);
    return json(
      {
        applications: list.map((a) => ({
          ...applicationJson(a),
          organization: a.tenant_name,
          subdomain: a.tenant_subdomain,
          hasCertificate: Boolean(a.certificate_key),
          certificateType: a.certificate_type,
          certificateSize: Number(a.certificate_size)
        }))
      },
      jsonHeaders
    );
  }

  const certificate = /^\/api\/super\/education\/([0-9a-f-]{36})\/certificate$/.exec(path);
  if (certificate && method === "GET") {
    const application = await findApplication(db, certificate[1]);
    if (!application?.certificate_key) return jsonError("Certificate not found", 404, jsonHeaders);
    const file = await readCertificate(env, application.certificate_key);
    if (!file) return jsonError("Certificate not found", 404, jsonHeaders);
    await writeAuditLog(db, { tenantId: application.tenant_id, userId, action: "plan.education_certificate_read", details: `application=${application.id}` });
    return new Response(file.body, {
      headers: {
        "Content-Type": file.type,
        "Content-Disposition": `inline; filename="${application.certificate_name.replace(/"/g, "")}"`,
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store"
      }
    });
  }

  if (path === "/api/super/education/decide" && method === "POST") {
    const body = await readJson(request);
    if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
    const decision = body.decision;
    if (decision !== "approve" && decision !== "reject") return jsonError("The decision must be approve or reject", 400, jsonHeaders);
    const reason = typeof body.reason === "string" ? body.reason.replace(/\s+/g, " ").trim().slice(0, EDUCATION_LIMITS.reason) : "";
    if (decision === "reject" && reason.length < 5) return jsonError("Say why, so the institution can fix it", 400, jsonHeaders);
    const application = await findApplication(db, String(body.id ?? ""));
    if (!application) return jsonError("Application not found", 404, jsonHeaders);
    const tenant = await findTenantById(db, application.tenant_id);
    if (!tenant) return jsonError("Organization not found", 404, jsonHeaders);
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const approve = decision === "approve";
    if (!(await decideApplication(db, application.id, approve, reason || null, userId, now))) {
      return jsonError("This application is not waiting for a decision", 409, jsonHeaders);
    }
    let emailed: boolean;
    if (approve) {
      const ends = now + PRICING.educationDays * DAY;
      const plan = entitlement(tenant, now);
      await updateTenant(db, tenant.id, {
        license_plan: "education",
        license_expires_at: ends,
        workstation_limit: Math.max(PRICING.educationWorkstations, plan.kind === "free" ? 0 : plan.limit)
      });
      await createNotification(db, {
        tenantId: tenant.id,
        kind: "license",
        title: "Education plan approved",
        body: `${application.institution} is verified. ${tenant.name} is on the free Education plan until ${licenseDate(ends)}; apply again under Plan before then to renew it.`,
        createdBy: userId
      });
      emailed = await emailOwner(
        ctx,
        tenant,
        "Your Education plan is approved",
        `We verified ${application.institution}. ${tenant.name} is on the free Lab Kiosk Education plan, with ${PRICING.educationWorkstations} workstations, until ${licenseDate(ends)}.\n\nLab Kiosk`
      );
      await syncLicences(env, db, tenant.id, nowMs);
    } else {
      await createNotification(db, {
        tenantId: tenant.id,
        kind: "license",
        title: "Education application not approved",
        body: `The Education application for ${application.institution} was not approved: ${reason} You can apply again under Plan.`,
        createdBy: userId
      });
      emailed = await emailOwner(
        ctx,
        tenant,
        "Your Education application was not approved",
        `We could not approve the Education application for ${application.institution}.\n\nReason: ${reason}\n\nYou can fix this and apply again under Plan in the console.\n\nLab Kiosk`
      );
    }
    await writeAuditLog(db, {
      tenantId: tenant.id,
      userId,
      action: approve ? "plan.education_approve" : "plan.education_reject",
      details: `application=${application.id}${reason ? ` reason=${reason}` : ""}`
    });
    return json({ status: "ok", emailed }, jsonHeaders);
  }

  return jsonError("Not found", 404, jsonHeaders);
}
