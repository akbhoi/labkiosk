/**
 * Organization signup and the public contact form.
 *
 * A signup proves its email and its phone (a texted code) and is active at
 * once on the Free plan: nobody approves it.
 */

import { ResellerApplication, createReseller, openResellerFor, parseResellerApplication } from "./partners";
import { LEGAL_DOCUMENTS, recordLegalAcceptances } from "./legal";
import { Env, Session, Tenant } from "./types";
import { isReservedSlug, jsonError } from "./guard";
import { cleanSubdomain } from "./escape";
import { ADDRESS_REFUSAL, NAME_REFUSAL, screenName } from "./name_screen";
import { PRICING } from "./plans";
import { breachedPasswordProblem, isPlausibleEmail, passwordPepper, validatePasswordStrength } from "./auth";
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
  categoryLabel,
  checkEmailCode,
  Conversation,
  CONTACT_REASONS,
  createConversation,
  createOrganizationProfile,
  discardEmailCode,
  EMPTY_ORGANIZATION_DETAILS,
  emailCodeCooldown,
  EMAIL_CODE_TTL_SECONDS,
  findOpenConversationForTenant,
  findOrganizationProfile,
  issueEmailCode,
  OrganizationDetails,
  organizationContactTaken,
  ProfileInput,
  saveOrganizationDetails,
  subjectWithReference
} from "./conversations";
import { mailConfigProblem, MailTemplate, sendMail, supportAddress, supportMailbox } from "./mail";
import { turnstileRefusal } from "./turnstile";
import { firebaseConfig, firebaseConfigProblem, phoneTokenMessage, verifyPhoneToken } from "./phone_verify";
import { STATES, cleanPostalCode, cleanTaxId, findCountry, findState, needsPostalCode, postalCodeProblem, taxIdProblem } from "./geo";

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
    await sendMail(env, { to, subject, text: body, template: { name: "notice", title: "For the platform owner" } });
  } catch (err) {
    console.error("[Signup] Could not notify the platform owner:", err);
  }
}

/**
 * Send a message on a conversation and record it there, whether or not the
 * provider accepted it. Returns false when it did not go out. Without a
 * template of its own it goes out as a reply, signed by `authorName`.
 */
export async function sendOnConversation(
  env: Env,
  db: D1Database,
  conversation: Conversation,
  body: string,
  options: {
    subject?: string;
    authorUserId?: string | null;
    authorName?: string | null;
    inReplyTo?: string | null;
    references?: string[];
    template?: MailTemplate;
    /** An automatic answer (a receipt for an incoming email). */
    autoReply?: boolean;
    /** What the conversation records instead of `body`, when the email carries a secret (a one-time link). */
    recordedBody?: string;
  } = {}
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
      mailbox: conversation.mailbox,
      autoReply: options.autoReply,
      template: options.template ?? {
        name: "reply",
        reference: conversation.reference,
        category: categoryLabel(conversation.category),
        author: options.authorName ?? null
      }
    }));
  } catch (err) {
    delivered = false;
    console.error(`[Inbox] Sending on ${conversation.reference} failed:`, err);
  }
  await addConversationMessage(db, {
    conversationId: conversation.id,
    direction: "outbound",
    body: options.recordedBody ?? body,
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
  let body: { email?: unknown; turnstileToken?: unknown };
  try {
    body = await ctx.request.json<typeof body>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const email = text(body?.email, 254).toLowerCase();
  if (!isPlausibleEmail(email)) return jsonError("Please enter a valid email address", 400, jsonHeaders);
  if (isDisposableEmail(email)) return jsonError("Please use a permanent work email address", 400, jsonHeaders);
  const refused = await turnstileRefusal(env, body?.turnstileToken, clientIp, "signup");
  if (refused) return jsonError(refused.message, refused.status, jsonHeaders);

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
  const code = await issueEmailCode(db, passwordPepper(env), "signup", email);
  try {
    await sendMail(env, {
      to: email,
      subject: `${code} is your Lab Kiosk verification code`,
      text:
        `Your Lab Kiosk verification code is ${code}.\n\n` +
        `Enter it in the registration form to confirm this email address. It expires in ${EMAIL_CODE_TTL_SECONDS / 60} minutes.\n\n` +
        `If you did not ask to register an organization, ignore this message; nothing happens without the code.`,
      template: { name: "code", code, purpose: "signup", minutes: EMAIL_CODE_TTL_SECONDS / 60 }
    });
  } catch (err) {
    console.error("[Signup] Sending a verification code failed:", err);
    await discardEmailCode(db, "signup", email);
    return jsonError("We could not send the code to that address. Check it and try again.", 502, jsonHeaders);
  }
  return json({ status: "ok", expiresIn: EMAIL_CODE_TTL_SECONDS }, jsonHeaders);
}

// ---------------------------------------------------------------------- signup
//
// Signup is two steps. The account first (POST /api/auth/register): the person,
// their verified email and phone, a password and the console address. Then,
// signed in, the organization (POST /api/tenant/organization): its name, type,
// address and tax ID. The console, enrolment and billing stay closed until the
// second step is done (tenants.profile_completed_at).
//
// Both the email and the phone are proved before anything is created, so the
// account is active at once on the Free plan: nobody approves it. Registration
// is closed while phone verification (Firebase) is not set up.

interface AccountBody {
  contactName?: unknown;
  email?: unknown;
  emailCode?: unknown;
  phone?: unknown;
  /** The Firebase ID token from the texted code (src/phone_verify.ts). */
  phoneToken?: unknown;
  password?: unknown;
  subdomain?: unknown;
  acceptTerms?: unknown;
}

interface AccountInput {
  contactName: string;
  email: string;
  phone: string;
  password: string;
  subdomain: string;
  emailCode: string;
}

/** The shortest and longest console address a customer may choose. */
export const SUBDOMAIN_LENGTH = { min: 3, max: 63 } as const;

/** Why `subdomain` (already through cleanSubdomain) cannot be a console address, or null. */
export function subdomainProblem(subdomain: string): string | null {
  if (subdomain.length < SUBDOMAIN_LENGTH.min || subdomain.length > SUBDOMAIN_LENGTH.max) {
    return `The console address must be ${SUBDOMAIN_LENGTH.min}-${SUBDOMAIN_LENGTH.max} characters: letters, numbers and hyphens`;
  }
  if (subdomain.startsWith("-") || subdomain.endsWith("-")) return "The console address cannot start or end with a hyphen";
  if (isReservedSlug(subdomain) || screenName(subdomain)) return ADDRESS_REFUSAL;
  return null;
}

/** The step 1 fields, cleaned, or the first problem with them. */
function readAccount(body: AccountBody): { problem: string } | { problem: null; value: AccountInput } {
  const contactName = text(body.contactName, 120);
  const email = text(body.email, 254).toLowerCase();
  const phone = normalizePhone(body.phone);
  const password = String(body.password ?? "");
  const subdomain = cleanSubdomain(body.subdomain);
  const emailCode = text(body.emailCode, 12);

  if (!contactName) return { problem: "Your name is required" };
  if (!isPlausibleEmail(email)) return { problem: "Please enter a valid email address" };
  if (isDisposableEmail(email)) return { problem: "Please use a permanent work email address" };
  if (!phone) return { problem: "Enter the phone number with its country code, for example +91 98765 43210" };
  const passwordProblem = validatePasswordStrength(password);
  if (passwordProblem) return { problem: passwordProblem };
  const addressProblem = subdomainProblem(subdomain);
  if (addressProblem) return { problem: addressProblem };
  if (!/^\d{6}$/.test(emailCode)) return { problem: "Enter the six-digit code we emailed you" };
  if (body.acceptTerms !== true) return { problem: "Please accept the Terms of Service and Privacy Policy" };
  return { problem: null, value: { contactName, email, phone, password, subdomain, emailCode } };
}

/** The organization fields of step 2. */
export interface OrganizationBody {
  name?: unknown;
  legalName?: unknown;
  organizationType?: unknown;
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
}

/** The step 2 fields, cleaned, or the first problem with them. */
export function readOrganization(body: OrganizationBody): { problem: string } | { problem: null; value: OrganizationDetails } {
  const name = text(body.name, 120);
  const addressLine1 = text(body.addressLine1, 200);
  const city = text(body.city, 100);
  const country = findCountry(body.country);
  const postalCode = cleanPostalCode(body.postalCode);
  const taxId = cleanTaxId(body.taxId);

  if (!name) return { problem: "Organization name is required" };
  if (screenName(name)) return { problem: NAME_REFUSAL };
  if (!country) return { problem: "Choose your country from the list" };
  if (!addressLine1 || !city) return { problem: "The street address and city are required" };
  if (!postalCode && needsPostalCode(country.code)) return { problem: "The postal code is required" };
  const postalProblem = postalCodeProblem(country.code, postalCode);
  if (postalProblem) return { problem: postalProblem };
  // A country whose states are listed takes one of them; any other, what was written.
  const region = STATES[country.code] ? findState(country.code, body.region) : text(body.region, 100) || null;
  if (STATES[country.code] && !region) {
    return { problem: `Choose the ${STATES[country.code].label.toLowerCase()} from the list` };
  }
  const taxProblem = taxIdProblem(country.code, taxId);
  if (taxProblem) return { problem: taxProblem };

  const billingEmail = text(body.billingEmail, 254).toLowerCase();
  if (billingEmail && !isPlausibleEmail(billingEmail)) return { problem: "The billing email address is not valid" };
  const legalName = text(body.legalName, 160);
  if (legalName && screenName(legalName)) return { problem: NAME_REFUSAL };
  const typeRaw = text(body.organizationType, 20).toLowerCase();
  const organizationType = (ORGANIZATION_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : null;
  const estimateRaw = Number(body.workstationEstimate);
  const workstationEstimate =
    Number.isInteger(estimateRaw) && estimateRaw > 0 && estimateRaw <= 100_000 ? estimateRaw : null;

  return {
    problem: null,
    value: {
      name,
      legal_name: legalName || null,
      address_line1: addressLine1,
      address_line2: text(body.addressLine2, 200) || null,
      city,
      region,
      postal_code: postalCode,
      country: country.name,
      tax_id: taxId || null,
      billing_email: billingEmail || null,
      workstation_estimate: workstationEstimate,
      organization_type: organizationType,
      notes: multiline(body.notes, 1000) || null
    }
  };
}

/** A signup's details as one readable block, for the task and the owner's notification. */
function signupSummary(p: ProfileInput, organizationName: string | null, subdomain: string, phoneVerified: boolean): string {
  const address = [p.address_line1, p.address_line2, p.city, p.region, p.postal_code, p.country].filter(Boolean).join(", ");
  const lines = [
    organizationName ? `Organization: ${organizationName}` : "Organization: (details not entered yet)",
    p.legal_name ? `Legal / billing name: ${p.legal_name}` : null,
    p.organization_type ? `Type: ${p.organization_type}` : null,
    `Console address: ${subdomain}`,
    `Contact: ${p.contact_name}`,
    `Email: ${p.contact_email} (verified by code)`,
    `Phone: ${p.contact_phone} (${phoneVerified ? "verified by text message code" : "not yet verified"})`,
    address ? `Address: ${address}` : null,
    p.tax_id ? `Tax ID: ${p.tax_id}` : null,
    p.billing_email ? `Billing email: ${p.billing_email}` : null,
    p.workstation_estimate ? `Expected workstations: ${p.workstation_estimate}` : null,
    p.notes ? `\nNotes from the customer:\n${p.notes}` : null
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** Where a new account signs in: the platform's sign-in page, which hands off to the console. */
function signInUrlFor(ctx: Pick<RouteContext, "url" | "baseDomain" | "isDev">): string {
  return ctx.isDev ? `${ctx.url.origin}/login` : `https://${ctx.baseDomain}/login`;
}

/**
 * POST /api/auth/register: step 1, the account.
 *
 * The email is proven by the emailed code and the phone by the texted one; one
 * organization per email address and per phone number. No
 * session is issued here: the customer signs in with the password just chosen,
 * which runs the same checks (two-factor, handoff to the console's host) as
 * every sign-in, and the console asks for the organization's details first.
 */
export async function handleRegister(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, clientIp } = ctx;
  const firebase = firebaseConfig(env);
  const problem = mailConfigProblem(env) || firebaseConfigProblem(env) || (firebase ? null : "Phone verification is not set up: registration needs FIREBASE_PROJECT_ID, FIREBASE_API_KEY and FIREBASE_AUTH_DOMAIN (docs/DEPLOYMENT.md).");
  if (problem || !firebase) {
    console.error("[Signup]", problem);
    return jsonError("Registration is temporarily unavailable. Please write to us instead.", 503, jsonHeaders);
  }
  let body: AccountBody;
  try {
    body = await ctx.request.json<AccountBody>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const read = readAccount(body || {});
  if (read.problem !== null) return jsonError(read.problem, 400, jsonHeaders);
  const account = read.value;

  const registerKey = `register:${clientIp}`;
  const wait = await rateLimitWait(db, registerKey, REGISTER_RATE_LIMIT.limit, REGISTER_RATE_LIMIT.windowSeconds);
  if (wait > 0) {
    return jsonError(`Too many registrations from this address. Try again in ${Math.ceil(wait / 60)} minute(s).`, 429, jsonHeaders);
  }
  await recordRateLimitHit(db, registerKey, REGISTER_RATE_LIMIT.windowSeconds);

  const breached = await breachedPasswordProblem(account.password, ctx.env);
  if (breached) return jsonError(breached, 400, jsonHeaders);

  // The number must come with Firebase's proof of the texted code.
  const checked = await verifyPhoneToken(firebase, body.phoneToken, account.phone);
  if (!checked.ok) {
    if (checked.reason === "unavailable") console.error("[Signup] Phone token not checked:", checked.detail);
    const refusal = phoneTokenMessage(checked);
    return jsonError(refusal.message, refusal.status, jsonHeaders);
  }
  const verifiedAt = Math.floor(Date.now() / 1000);

  const verdict = await checkEmailCode(db, passwordPepper(env), "signup", account.email, account.emailCode);
  if (verdict === "expired") return jsonError("That code has expired. Ask for a new one.", 400, jsonHeaders);
  if (verdict === "wrong") return jsonError("That code is not correct", 400, jsonHeaders);

  // Said only after both codes checked out, so the answer goes to the owner of
  // the address and the number, not to someone testing which are registered.
  if (await findUserByEmail(db, account.email)) {
    return jsonError("Email already registered. Please sign in.", 409, jsonHeaders);
  }
  const taken = await organizationContactTaken(db, account.email, account.phone);
  if (taken === "email") return jsonError("Email already registered. Please sign in.", 409, jsonHeaders);
  if (taken === "phone") {
    return jsonError("This phone number is already registered to another organization. Each organization needs its own number.", 409, jsonHeaders);
  }
  if (await subdomainTaken(db, account.subdomain)) {
    return jsonError("That console address is already taken. Choose another.", 409, jsonHeaders);
  }

  const user = await createUser(db, {
    email: account.email,
    password: account.password,
    name: account.contactName,
    role: "org_admin"
  }, passwordPepper(ctx.env));
  // The organization is named after its address until step 2 gives it a name.
  const tenant = await createTenant(db, {
    userId: user.id,
    name: account.subdomain,
    subdomain: account.subdomain,
    status: "active",
    profileCompleted: false,
    workstationLimit: PRICING.freeWorkstations
  });
  const profile: ProfileInput = {
    ...EMPTY_ORGANIZATION_DETAILS,
    contact_name: account.contactName,
    contact_email: account.email,
    contact_phone: account.phone,
    email_verified_at: verifiedAt
  };
  await createOrganizationProfile(db, tenant.id, profile, verifiedAt);
  await discardEmailCode(db, "signup", account.email);
  // The record of what the registrant agreed to: every document in force, at its current version.
  await recordLegalAcceptances(db, {
    tenantId: tenant.id,
    tenantName: account.subdomain,
    userId: user.id,
    userEmail: account.email,
    documents: LEGAL_DOCUMENTS.map((doc) => ({ id: doc.id, version: doc.version })),
    source: "registration",
    ip: clientIp,
    userAgent: ctx.request.headers.get("User-Agent")
  });
  const host = `${account.subdomain}.${ctx.baseDomain}`;
  const signIn = signInUrlFor(ctx);

  await writeAuditLog(db, { tenantId: tenant.id, userId: user.id, action: "tenant.register", details: `subdomain=${tenant.subdomain} active=1` });
  try {
    await sendMail(env, {
      to: account.email,
      subject: "Your Lab Kiosk account is ready",
      text:
        `Hello ${account.contactName},\n\n` +
        `Your Lab Kiosk account is ready, with the console address ${host}.\n\n` +
        `Sign in with your email address and the password you chose to finish setting up: ` +
        `your organization's name and address come next, then you can enrol up to ${PRICING.freeWorkstations} workstations on the Free plan or choose another plan.\n\n` +
        `${signIn}\n\nLab Kiosk`,
      template: { name: "notice", title: "Your account is ready" }
    });
  } catch (err) {
    // The account exists and works; the welcome is a courtesy.
    console.error("[Signup] The welcome email was not sent:", err);
  }
  await notifyPlatformOwner(
    env,
    `New account: ${host}`,
    `${signupSummary(profile, null, host, true)}\n\nThe account is active on the Free plan. Nothing needs approving.`
  );
  return json({ status: "ok", active: true, signIn }, jsonHeaders);
}

/** Whether a console address is in use, as an organization's address or one it asked for. */
async function subdomainTaken(db: D1Database, subdomain: string): Promise<boolean> {
  if (await findTenantBySubdomain(db, subdomain)) return true;
  const requested = await db.prepare("SELECT 1 AS hit FROM tenants WHERE requested_subdomain = ? LIMIT 1").bind(subdomain).first();
  return Boolean(requested);
}

/**
 * POST /api/tenant/organization: step 2, the organization's details. The
 * owner of the account only, once: afterwards they are changed through
 * support, because invoices already carry them.
 */
export async function handleCompleteOrganization(ctx: RouteContext, tenant: Tenant): Promise<Response> {
  const { db, env, jsonHeaders, session } = ctx;
  if (!session || session.user_id !== tenant.user_id) {
    return jsonError("Only the person who registered the organization can enter its details", 403, jsonHeaders);
  }
  if (tenant.profile_completed_at) return jsonError("The organization's details are already entered", 409, jsonHeaders);
  let body: OrganizationBody;
  try {
    body = await ctx.request.json<OrganizationBody>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const read = readOrganization(body || {});
  if (read.problem !== null) return jsonError(read.problem, 400, jsonHeaders);
  const details = read.value;

  await saveOrganizationDetails(db, tenant.id, details);
  await updateTenant(db, tenant.id, { name: details.name, profile_completed_at: Math.floor(Date.now() / 1000) });
  await writeAuditLog(db, { tenantId: tenant.id, userId: session.user_id, action: "tenant.complete_profile", details: `name=${details.name}` });

  const profile = await findOrganizationProfile(db, tenant.id);
  const host = `${tenant.subdomain}.${ctx.baseDomain}`;
  const summary = profile ? signupSummary(profile, details.name, host, Boolean(profile.phone_verified_at)) : `Organization: ${details.name}`;
  // A registration still under review carries its details to the task.
  const conversation = await findOpenConversationForTenant(db, tenant.id, "signup");
  if (conversation) {
    await addConversationMessage(db, { conversationId: conversation.id, direction: "event", body: `Organization details entered.\n\n${summary}` });
  }
  await notifyPlatformOwner(env, `Organization set up: ${details.name}`, summary);
  return json({ status: "ok", name: details.name }, jsonHeaders);
}

// ------------------------------------------------------------------ contact form

/**
 * POST /api/contact/email-code { email, turnstileToken }: send the six-digit
 * code that proves the address a message will be answered at. This is the
 * step a stranger can make the platform send mail with, so it is the one
 * Turnstile stands in front of; the code then stands in front of the message.
 */
export async function handleContactEmailCode(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, clientIp } = ctx;
  const problem = mailConfigProblem(env);
  if (problem) {
    console.error("[Contact]", problem);
    return jsonError("The contact form is temporarily unavailable. Please write to us by email instead.", 503, jsonHeaders);
  }
  let body: { email?: unknown; turnstileToken?: unknown };
  try {
    body = await ctx.request.json<typeof body>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const email = text(body?.email, 254).toLowerCase();
  if (!isPlausibleEmail(email)) return jsonError("Please enter a valid email address", 400, jsonHeaders);
  const refused = await turnstileRefusal(env, body?.turnstileToken, clientIp, "contact");
  if (refused) return jsonError(refused.message, refused.status, jsonHeaders);

  const addressKey = `contact-code:${clientIp}`;
  const emailKey = `contact-code-email:${email}`;
  const waitAddress = await rateLimitWait(db, addressKey, CODE_RATE_LIMIT.perAddress, CODE_RATE_LIMIT.windowSeconds);
  const waitEmail = await rateLimitWait(db, emailKey, CODE_RATE_LIMIT.perEmail, CODE_RATE_LIMIT.windowSeconds);
  if (waitAddress > 0 || waitEmail > 0) {
    return jsonError(`Too many codes requested. Try again in ${Math.ceil(Math.max(waitAddress, waitEmail) / 60)} minute(s).`, 429, jsonHeaders);
  }
  const cooldown = await emailCodeCooldown(db, "contact", email);
  if (cooldown > 0) return jsonError(`A code was just sent. You can ask for another in ${cooldown} seconds.`, 429, jsonHeaders);

  await recordRateLimitHit(db, addressKey, CODE_RATE_LIMIT.windowSeconds);
  await recordRateLimitHit(db, emailKey, CODE_RATE_LIMIT.windowSeconds);
  const code = await issueEmailCode(db, passwordPepper(env), "contact", email);
  try {
    await sendMail(env, {
      to: email,
      subject: `${code} is your Lab Kiosk verification code`,
      text:
        `Your Lab Kiosk verification code is ${code}.\n\n` +
        `Enter it in the contact form to confirm this email address. It expires in ${EMAIL_CODE_TTL_SECONDS / 60} minutes.\n\n` +
        `If you did not start a message to Lab Kiosk, ignore this one; nothing is sent without the code.`,
      template: { name: "code", code, purpose: "contact", minutes: EMAIL_CODE_TTL_SECONDS / 60 }
    });
  } catch (err) {
    console.error("[Contact] Sending a verification code failed:", err);
    await discardEmailCode(db, "contact", email);
    return jsonError("We could not send the code to that address. Check it and try again.", 502, jsonHeaders);
  }
  return json({ status: "ok", expiresIn: EMAIL_CODE_TTL_SECONDS }, jsonHeaders);
}

/**
 * POST /api/contact { name, organization?, email, emailCode, reason, message }:
 * the contact page's message, filed into Mail under the type its reason names.
 * Nothing is filed for an address that was not proved with the emailed code.
 */
export async function handleContactForm(ctx: RouteContext): Promise<Response> {
  const { db, env, jsonHeaders, clientIp } = ctx;
  const problem = mailConfigProblem(env);
  if (problem) {
    console.error("[Contact]", problem);
    return jsonError("The contact form is temporarily unavailable. Please write to us by email instead.", 503, jsonHeaders);
  }
  let body: {
    name?: unknown;
    organization?: unknown;
    email?: unknown;
    emailCode?: unknown;
    reason?: unknown;
    message?: unknown;
    phone?: unknown;
    state?: unknown;
    city?: unknown;
    website?: unknown;
    stocks?: unknown;
  };
  try {
    body = await ctx.request.json<typeof body>();
  } catch {
    return jsonError("The request body must be JSON", 400, jsonHeaders);
  }
  const name = text(body?.name, 120);
  const organization = text(body?.organization, 160);
  const email = text(body?.email, 254).toLowerCase();
  const emailCode = text(body?.emailCode, 12);
  const reason = CONTACT_REASONS.find((r) => r.value === text(body?.reason, 40));
  const message = multiline(body?.message, 5000);
  if (!name || !email || !message) return jsonError("Your name, email address and a message are required", 400, jsonHeaders);
  if (!isPlausibleEmail(email)) return jsonError("Please enter a valid email address", 400, jsonHeaders);
  if (!reason) return jsonError("Please choose what your message is about", 400, jsonHeaders);
  if (!emailCode) return jsonError("Enter the code we emailed you. Use Send code if you do not have one.", 400, jsonHeaders);
  // "Become a reseller" carries the listing's details too (src/partners.ts).
  let reseller: ResellerApplication | null = null;
  if (reason.value === "reseller") {
    const parsed = parseResellerApplication(organization, body);
    if (!parsed.ok) return jsonError(parsed.error, 400, jsonHeaders);
    reseller = parsed.value;
    const existing = await openResellerFor(db, email);
    if (existing) {
      return jsonError(
        existing.status === "approved"
          ? "This address is already listed as a reseller. Write to us to change the listing."
          : "An application from this address is already waiting for review. We will reply by email.",
        409,
        jsonHeaders
      );
    }
  }

  const key = `contact:${clientIp}`;
  const wait = await rateLimitWait(db, key, CONTACT_RATE_LIMIT.limit, CONTACT_RATE_LIMIT.windowSeconds);
  if (wait > 0) return jsonError(`Too many messages from this address. Try again in ${Math.ceil(wait / 60)} minute(s).`, 429, jsonHeaders);

  const verdict = await checkEmailCode(db, passwordPepper(env), "contact", email, emailCode);
  if (verdict === "expired") return jsonError("That code has expired. Ask for a new one.", 400, jsonHeaders);
  if (verdict === "wrong") return jsonError("That code is not correct", 400, jsonHeaders);
  await recordRateLimitHit(db, key, CONTACT_RATE_LIMIT.windowSeconds);

  const conversation = await createConversation(db, {
    kind: "support",
    tenantId: null,
    subject: `${reason.label}: ${organization || name}`,
    contactEmail: email,
    contactName: name,
    mailbox: supportMailbox(env),
    category: reason.category
  });
  const listing = reseller
    ? `\n\nReseller listing:\nCompany: ${reseller.company}\nPhone: ${reseller.phone}\nState: ${reseller.state}\nCity: ${reseller.city}\n` +
      `Website: ${reseller.website ?? "-"}\nStocks: ${reseller.stocks ?? "-"}\nApprove or reject it in Super Admin -> System -> Hardware.`
    : "";
  if (reseller) await createReseller(db, reseller, { name, email }, conversation.id, Math.floor(Date.now() / 1000));
  await addConversationMessage(db, {
    conversationId: conversation.id,
    direction: "inbound",
    body: `${message}${listing}\n\n-- Sent with the contact form${organization ? ` on behalf of ${organization}` : ""}. The sender proved this address with an emailed code.`,
    fromAddress: email,
    subject: conversation.subject
  });
  // The code did its one job.
  await discardEmailCode(db, "contact", email);

  // The address is proved, so the sender gets a receipt with the reference to quote.
  await sendOnConversation(
    env,
    db,
    conversation,
    `Hello ${name},\n\n` +
      `We received your message (reference ${conversation.reference}) and will reply to this address. ` +
      `To add to it, reply to this email and keep the reference in the subject.\n\nLab Kiosk`,
    {
      subject: "We received your message",
      autoReply: true,
      template: { name: "receipt", reference: conversation.reference, category: categoryLabel(conversation.category), title: "We received your message" }
    }
  );
  await notifyPlatformOwner(
    env,
    subjectWithReference(conversation.reference, `Contact form: ${conversation.subject}`),
    `From: ${name} <${email}> (address verified)\nOrganization: ${organization || "-"}\nAbout: ${reason.label}\n\n${message}${listing}\n\nReply from Mail in the Super Admin console.`
  );
  return json({ status: "ok", reference: conversation.reference }, jsonHeaders);
}
