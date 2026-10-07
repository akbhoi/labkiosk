/**
 * Organization signup, the public contact form, and an organization's request
 * for Remote Control -- everything a customer asks the platform for.
 *
 * Nothing here grants anything. A signup creates the account as `pending`; a
 * Remote Control request sets `remote_control_status` to `pending`. Each opens a
 * conversation in the Super Admin console's Tasks, where the platform owner
 * approves, rejects, or writes back (for example, to ask for payment), all by
 * email sent from the console (src/inbox.ts).
 */

import { Env, Session, Tenant } from "./types";
import { jsonError, isReservedSlug } from "./guard";
import { cleanSubdomain } from "./escape";
import { isPlausibleEmail, validatePasswordStrength } from "./auth";
import {
  createTenant,
  createUser,
  findTenantBySubdomain,
  findUserByEmail,
  findUserById,
  rateLimitWait,
  recordRateLimitHit,
  updateTenant,
  writeAuditLog
} from "./db";
import {
  addConversationMessage,
  checkEmailCode,
  Conversation,
  createConversation,
  createOrganizationProfile,
  discardEmailCode,
  emailCodeCooldown,
  EMAIL_CODE_TTL_SECONDS,
  findOpenConversationForTenant,
  issueEmailCode,
  ProfileInput,
  subjectWithReference
} from "./conversations";
import { mailConfigProblem, sendMail, supportAddress, supportMailbox } from "./mail";

/** What every handler in this module is given by the router. */
export interface RouteContext {
  request: Request;
  env: Env;
  db: D1Database;
  url: URL;
  session: Session | null;
  jsonHeaders: Record<string, string>;
  clientIp: string;
  baseDomain: string;
  isDev: boolean;
}

/** Codes requested per source address, and per email address, per hour. */
const CODE_RATE_LIMIT = { perAddress: 10, perEmail: 5, windowSeconds: 3600 };
/** Contact-form messages accepted per source address per hour. */
const CONTACT_RATE_LIMIT = { limit: 5, windowSeconds: 3600 };
/** Registrations per source address per hour (shared with the previous limit). */
const REGISTER_RATE_LIMIT = { limit: 10, windowSeconds: 3600 };

export const ORGANIZATION_TYPES = ["business", "government", "library", "education", "nonprofit", "other"] as const;

/**
 * Throwaway-inbox providers. Not exhaustive -- a determined person finds
 * another -- but it stops the common ones from holding a signup open.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "burnermail.io",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mintemail.com",
  "mohmal.com",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.org",
  "tempail.com",
  "tempmail.com",
  "tempmailo.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com"
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] || "";
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/**
 * A phone number in international form, or null. Spaces, dots, dashes and
 * brackets are dropped; the country code is required because the platform
 * serves organizations in any country.
 */
export function normalizePhone(raw: unknown): string | null {
  const compact = String(raw ?? "").trim().replace(/[\s().-]/g, "");
  const withPlus = compact.startsWith("00") ? "+" + compact.slice(2) : compact;
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

function text(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function multiline(value: unknown, max: number): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function json(data: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

/** The sign-in address of an organization's console. */
export function consoleUrlFor(ctx: Pick<RouteContext, "url" | "baseDomain" | "isDev">, subdomain: string): string {
  return ctx.isDev
    ? `${ctx.url.origin}/admin?tenant=${encodeURIComponent(subdomain)}`
    : `https://${subdomain}.${ctx.baseDomain}/admin`;
}

/** Tell the platform owner something happened, at the verified forwarding address. Best effort. */
export async function notifyPlatformOwner(env: Env, subject: string, body: string): Promise<void> {
  const to = env.SUPPORT_FORWARD_TO;
  if (!to) return;
  try {
    await sendMail(env, { to, subject, text: body });
  } catch (err) {
    console.error("[Signup] Could not notify the platform owner:", err);
  }
}

/**
 * Send a message on a conversation and record it there, whether or not the
 * provider accepted it. Returns false when it did not go out.
 */
export async function sendOnConversation(
  env: Env,
  db: D1Database,
  conversation: Conversation,
  body: string,
  options: { subject?: string; authorUserId?: string | null; inReplyTo?: string | null; references?: string[] } = {}
): Promise<boolean> {
  const subject = subjectWithReference(conversation.reference, options.subject || conversation.subject);
  let messageId: string | null = null;
  let delivered = true;
  try {
    ({ messageId } = await sendMail(env, {
      to: conversation.contact_email,
      toName: conversation.contact_name,
      subject,
      text: body,
      inReplyTo: options.inReplyTo,
      references: options.references,
      mailbox: conversation.mailbox
    }));
  } catch (err) {
    delivered = false;
    console.error(`[Inbox] Sending on ${conversation.reference} failed:`, err);
  }
  await addConversationMessage(db, {
    conversationId: conversation.id,
    direction: "outbound",
    body,
    fromAddress: conversation.mailbox || supportAddress(env),
    toAddress: conversation.contact_email,
    subject,
    emailMessageId: messageId,
    authorUserId: options.authorUserId ?? null,
    delivery: delivered ? "sent" : "failed"
  });
  return delivered;
}

// ------------------------------------------------------------------ signup codes

/** POST /api/auth/register/email-code { email }: send the six-digit code that proves the address. */
export async function handleSignupEmailCode(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, clientIp } = ctx;
  const problem = mailConfigProblem(env);
  if (problem) {
    console.error("[Signup]", problem);
    return jsonError("Registration is temporarily unavailable. Please write to us instead.", 503, jsonHeaders);
  }
  let body: { email?: unknown };
  try {
    body = await ctx.request.json<typeof body>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const email = text(body?.email, 254).toLowerCase();
  if (!isPlausibleEmail(email)) return jsonError("Please enter a valid email address", 400, jsonHeaders);
  if (isDisposableEmail(email)) return jsonError("Please use a permanent work email address", 400, jsonHeaders);

  const addressKey = `signup-code:${clientIp}`;
  const emailKey = `signup-code-email:${email}`;
  const waitAddress = await rateLimitWait(db, addressKey, CODE_RATE_LIMIT.perAddress, CODE_RATE_LIMIT.windowSeconds);
  const waitEmail = await rateLimitWait(db, emailKey, CODE_RATE_LIMIT.perEmail, CODE_RATE_LIMIT.windowSeconds);
  if (waitAddress > 0 || waitEmail > 0) {
    return jsonError(`Too many codes requested. Try again in ${Math.ceil(Math.max(waitAddress, waitEmail) / 60)} minute(s).`, 429, jsonHeaders);
  }
  const cooldown = await emailCodeCooldown(db, "signup", email);
  if (cooldown > 0) return jsonError(`A code was just sent. You can ask for another in ${cooldown} seconds.`, 429, jsonHeaders);

  if (await findUserByEmail(db, email)) {
    return jsonError("Email already registered. Please sign in.", 409, jsonHeaders);
  }

  await recordRateLimitHit(db, addressKey, CODE_RATE_LIMIT.windowSeconds);
  await recordRateLimitHit(db, emailKey, CODE_RATE_LIMIT.windowSeconds);
  const code = await issueEmailCode(db, "signup", email);
  try {
    await sendMail(env, {
      to: email,
      subject: `${code} is your Lab Kiosk verification code`,
      text:
        `Your Lab Kiosk verification code is ${code}.\n\n` +
        `Enter it in the registration form to confirm this email address. It expires in ${EMAIL_CODE_TTL_SECONDS / 60} minutes.\n\n` +
        `If you did not ask to register an organization, ignore this message; nothing happens without the code.`
    });
  } catch (err) {
    console.error("[Signup] Sending a verification code failed:", err);
    await discardEmailCode(db, "signup", email);
    return jsonError("We could not send the code to that address. Check it and try again.", 502, jsonHeaders);
  }
  return json({ status: "ok", expiresIn: EMAIL_CODE_TTL_SECONDS }, jsonHeaders);
}

// ---------------------------------------------------------------------- signup

interface SignupBody {
  name?: unknown;
  legalName?: unknown;
  organizationType?: unknown;
  contactName?: unknown;
  email?: unknown;
  emailCode?: unknown;
  phone?: unknown;
  password?: unknown;
  subdomain?: unknown;
  addressLine1?: unknown;
  addressLine2?: unknown;
  city?: unknown;
  region?: unknown;
  postalCode?: unknown;
  country?: unknown;
  taxId?: unknown;
  billingEmail?: unknown;
  workstationEstimate?: unknown;
  notes?: unknown;
  acceptTerms?: unknown;
}

/** The request's fields, cleaned, or the first problem with them. */
function readSignup(body: SignupBody): { problem: string } | { problem: null; value: ProfileInput & { name: string; password: string; subdomain: string; emailCode: string } } {
  const name = text(body.name, 120);
  const contactName = text(body.contactName, 120);
  const email = text(body.email, 254).toLowerCase();
  const phone = normalizePhone(body.phone);
  const password = String(body.password ?? "");
  const subdomain = cleanSubdomain(body.subdomain);
  const addressLine1 = text(body.addressLine1, 200);
  const city = text(body.city, 100);
  const postalCode = text(body.postalCode, 20);
  const country = text(body.country, 80);
  const emailCode = text(body.emailCode, 12);

  if (!name) return { problem: "Organization name is required" };
  if (!contactName) return { problem: "The technical contact's name is required" };
  if (!isPlausibleEmail(email)) return { problem: "Please enter a valid email address" };
  if (isDisposableEmail(email)) return { problem: "Please use a permanent work email address" };
  if (!phone) return { problem: "Enter the phone number with its country code, for example +91 98765 43210" };
  const passwordProblem = validatePasswordStrength(password);
  if (passwordProblem) return { problem: passwordProblem };
  if (subdomain.length < 3 || subdomain.length > 63) {
    return { problem: "Subdomain must be 3-63 characters (letters, numbers, hyphens)" };
  }
  if (isReservedSlug(subdomain)) return { problem: "That subdomain is reserved by the platform. Please pick another." };
  if (!addressLine1 || !city || !postalCode || !country) {
    return { problem: "The street address, city, postal code and country are required" };
  }
  if (!/^\d{6}$/.test(emailCode)) return { problem: "Enter the six-digit code we emailed you" };
  if (body.acceptTerms !== true) return { problem: "Please accept the Terms of Service and Privacy Policy" };

  const billingEmail = text(body.billingEmail, 254).toLowerCase();
  if (billingEmail && !isPlausibleEmail(billingEmail)) return { problem: "The billing email address is not valid" };
  const typeRaw = text(body.organizationType, 20).toLowerCase();
  const organizationType = (ORGANIZATION_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : null;
  const estimateRaw = Number(body.workstationEstimate);
  const workstationEstimate =
    Number.isInteger(estimateRaw) && estimateRaw > 0 && estimateRaw <= 100_000 ? estimateRaw : null;

  return {
    problem: null,
    value: {
      name,
      password,
      subdomain,
      emailCode,
      legal_name: text(body.legalName, 160) || null,
      contact_name: contactName,
      contact_email: email,
      contact_phone: phone,
      email_verified_at: null,
      address_line1: addressLine1,
      address_line2: text(body.addressLine2, 200) || null,
      city,
      region: text(body.region, 100) || null,
      postal_code: postalCode,
      country,
      tax_id: text(body.taxId, 40) || null,
      billing_email: billingEmail || null,
      workstation_estimate: workstationEstimate,
      organization_type: organizationType,
      notes: multiline(body.notes, 1000) || null
    }
  };
}

/** A signup's details as one readable block, for the task and the owner's notification. */
function signupSummary(p: ProfileInput, organizationName: string, subdomain: string): string {
  const lines = [
    `Organization: ${organizationName}`,
    p.legal_name ? `Legal / billing name: ${p.legal_name}` : null,
    p.organization_type ? `Type: ${p.organization_type}` : null,
    `Requested address: ${subdomain}`,
    `Technical contact: ${p.contact_name}`,
    `Email: ${p.contact_email} (verified by code)`,
    `Phone: ${p.contact_phone} (not yet verified)`,
    `Address: ${[p.address_line1, p.address_line2, p.city, p.region, p.postal_code, p.country].filter(Boolean).join(", ")}`,
    p.tax_id ? `Tax ID: ${p.tax_id}` : null,
    p.billing_email ? `Billing email: ${p.billing_email}` : null,
    p.workstation_estimate ? `Expected workstations: ${p.workstation_estimate}` : null,
    p.notes ? `\nNotes from the customer:\n${p.notes}` : null
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * POST /api/auth/register: create the organization as `pending`.
 *
 * The email is proven by the code; the phone is confirmed by the platform owner
 * before approval. No session is issued: the account cannot be used until it
 * is approved, and the customer is told so by email.
 */
export async function handleRegister(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, clientIp } = ctx;
  const problem = mailConfigProblem(env);
  if (problem) {
    console.error("[Signup]", problem);
    return jsonError("Registration is temporarily unavailable. Please write to us instead.", 503, jsonHeaders);
  }
  let body: SignupBody;
  try {
    body = await ctx.request.json<SignupBody>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const read = readSignup(body || {});
  if (read.problem !== null) return jsonError(read.problem, 400, jsonHeaders);
  const signup = read.value;

  const registerKey = `register:${clientIp}`;
  const wait = await rateLimitWait(db, registerKey, REGISTER_RATE_LIMIT.limit, REGISTER_RATE_LIMIT.windowSeconds);
  if (wait > 0) {
    return jsonError(`Too many registrations from this address. Try again in ${Math.ceil(wait / 60)} minute(s).`, 429, jsonHeaders);
  }
  await recordRateLimitHit(db, registerKey, REGISTER_RATE_LIMIT.windowSeconds);

  const verdict = await checkEmailCode(db, "signup", signup.contact_email, signup.emailCode);
  if (verdict === "expired") return jsonError("That code has expired. Ask for a new one.", 400, jsonHeaders);
  if (verdict === "wrong") return jsonError("That code is not correct", 400, jsonHeaders);

  if (await findUserByEmail(db, signup.contact_email)) {
    return jsonError("Email already registered. Please sign in.", 409, jsonHeaders);
  }
  if (await findTenantBySubdomain(db, signup.subdomain)) {
    return jsonError("Subdomain already claimed. Please pick another.", 409, jsonHeaders);
  }

  const user = await createUser(db, {
    email: signup.contact_email,
    password: signup.password,
    name: signup.contact_name,
    role: "org_admin"
  });
  const tenant = await createTenant(db, { userId: user.id, name: signup.name, subdomain: signup.subdomain, status: "pending" });
  const profile: ProfileInput = { ...signup, email_verified_at: Math.floor(Date.now() / 1000) };
  await createOrganizationProfile(db, tenant.id, profile);
  await discardEmailCode(db, "signup", signup.contact_email);

  const conversation = await createConversation(db, {
    kind: "signup",
    tenantId: tenant.id,
    subject: `Registration of ${signup.name}`,
    contactEmail: signup.contact_email,
    contactName: signup.contact_name
  });
  const summary = signupSummary(profile, signup.name, `${signup.subdomain}.${ctx.baseDomain}`);
  await addConversationMessage(db, {
    conversationId: conversation.id,
    direction: "event",
    body: `New registration.\n\n${summary}`,
    fromAddress: signup.contact_email
  });
  await writeAuditLog(db, {
    tenantId: tenant.id,
    userId: user.id,
    action: "tenant.register",
    details: `subdomain=${tenant.subdomain} reference=${conversation.reference}`
  });

  await sendOnConversation(
    env,
    db,
    conversation,
    `Hello ${signup.contact_name},\n\n` +
      `Thank you for registering ${signup.name} with Lab Kiosk. Your request reference is ${conversation.reference}.\n\n` +
      `Your account will be activated once our team has reviewed it. We will confirm your phone number (${signup.contact_phone}) ` +
      `and may write to you about licensing first. You will receive an email as soon as the account is active, ` +
      `with the address of your console: ${signup.subdomain}.${ctx.baseDomain}.\n\n` +
      `Reply to this email if you have any questions.\n\nLab Kiosk`,
    { subject: "We received your registration" }
  );
  await notifyPlatformOwner(
    env,
    subjectWithReference(conversation.reference, `New registration: ${signup.name}`),
    `${summary}\n\nReview it under Tasks in the Super Admin console.`
  );

  return json({ status: "ok", pending: true, reference: conversation.reference }, jsonHeaders);
}

// ------------------------------------------------------------------ contact form

/** POST /api/contact: the public contact form, filed straight into Mail. */
export async function handleContactForm(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, clientIp } = ctx;
  let body: { name?: unknown; organization?: unknown; email?: unknown; topic?: unknown; message?: unknown };
  try {
    body = await ctx.request.json<typeof body>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const name = text(body?.name, 120);
  const organization = text(body?.organization, 160);
  const email = text(body?.email, 254).toLowerCase();
  const topic = text(body?.topic, 60) || "General";
  const message = multiline(body?.message, 5000);
  if (!name || !email || !message) return jsonError("Your name, email address and a message are required", 400, jsonHeaders);
  if (!isPlausibleEmail(email)) return jsonError("Please enter a valid email address", 400, jsonHeaders);

  const key = `contact:${clientIp}`;
  const wait = await rateLimitWait(db, key, CONTACT_RATE_LIMIT.limit, CONTACT_RATE_LIMIT.windowSeconds);
  if (wait > 0) return jsonError(`Too many messages from this address. Try again in ${Math.ceil(wait / 60)} minute(s).`, 429, jsonHeaders);
  await recordRateLimitHit(db, key, CONTACT_RATE_LIMIT.windowSeconds);

  const conversation = await createConversation(db, {
    kind: "support",
    tenantId: null,
    subject: `[${topic}] ${organization || name}`,
    contactEmail: email,
    contactName: name,
    mailbox: supportMailbox(env)
  });
  await addConversationMessage(db, {
    conversationId: conversation.id,
    direction: "inbound",
    body: `${message}\n\n-- Sent with the contact form${organization ? ` on behalf of ${organization}` : ""}.`,
    fromAddress: email,
    subject: conversation.subject
  });
  await notifyPlatformOwner(
    env,
    subjectWithReference(conversation.reference, `Contact form: ${conversation.subject}`),
    `From: ${name} <${email}>\nOrganization: ${organization || "-"}\nTopic: ${topic}\n\n${message}\n\nReply from Mail in the Super Admin console.`
  );
  return json({ status: "ok", reference: conversation.reference }, jsonHeaders);
}

// ------------------------------------------------------- Remote Control request

/**
 * POST /api/tenant/remote-control/request { reason }: an organization asks the
 * platform to turn Remote Control on. Guarded by the router (`settings`).
 */
export async function handleRemoteControlRequest(ctx: RouteContext, tenant: Tenant): Promise<Response> {
  const { db, env, jsonHeaders } = ctx;
  const status = tenant.remote_control_status || "none";
  if (status === "approved") return jsonError("Remote Control is already available to this organization", 409, jsonHeaders);
  if (status === "pending") return jsonError("Remote Control has already been requested and is waiting for review", 409, jsonHeaders);
  const problem = mailConfigProblem(env);
  if (problem) {
    console.error("[Signup]", problem);
    return jsonError("Requests are temporarily unavailable. Please write to support instead.", 503, jsonHeaders);
  }
  let body: { reason?: unknown } = {};
  try {
    body = await ctx.request.json<typeof body>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const reason = multiline(body?.reason, 2000);
  const requester = await findUserById(db, ctx.session!.user_id);
  if (!requester) return jsonError("Authentication required", 401, jsonHeaders);

  await updateTenant(db, tenant.id, { remote_control_status: "pending" });
  const existing = await findOpenConversationForTenant(db, tenant.id, "remote_control");
  const conversation =
    existing ||
    (await createConversation(db, {
      kind: "remote_control",
      tenantId: tenant.id,
      subject: `Remote Control for ${tenant.name}`,
      contactEmail: requester.email,
      contactName: requester.name
    }));
  await addConversationMessage(db, {
    conversationId: conversation.id,
    direction: "event",
    body:
      `${requester.name} <${requester.email}> asked for Remote Control for ${tenant.name} (${tenant.subdomain}).` +
      (reason ? `\n\nReason given:\n${reason}` : ""),
    fromAddress: requester.email
  });
  await writeAuditLog(db, {
    tenantId: tenant.id,
    userId: requester.id,
    action: "remote_control.request",
    details: `reference=${conversation.reference}`
  });
  await sendOnConversation(
    env,
    db,
    conversation,
    `Hello ${requester.name},\n\n` +
      `We received your request to turn on Remote Control for ${tenant.name} (reference ${conversation.reference}). ` +
      `We will email you when it has been reviewed; licensing may need to be arranged first.\n\nLab Kiosk`,
    { subject: "Remote Control request received" }
  );
  await notifyPlatformOwner(
    env,
    subjectWithReference(conversation.reference, `Remote Control requested: ${tenant.name}`),
    `${requester.name} <${requester.email}> asked for Remote Control for ${tenant.name} (${tenant.subdomain}).` +
      (reason ? `\n\n${reason}` : "") +
      "\n\nReview it under Tasks in the Super Admin console."
  );
  return json({ status: "ok", remoteControlStatus: "pending", reference: conversation.reference }, jsonHeaders);
}
