/**
 * Two-factor sign-in and sign-in alerts, for every account (organization staff
 * and super admins).
 *
 * - The second factor is a six-digit code emailed to the account's address:
 *   nothing to set up. A super admin is always asked for it; an organization
 *   account turns it on under Settings (`users.two_factor_email`).
 * - An authenticator app (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, six
 *   digits) can be added on top; turning it on hands out ten single-use
 *   recovery codes. With an app, sign-in asks for its code and an emailed one
 *   stays available.
 * - After the password checks out, such an account gets a short-lived
 *   challenge instead of a session. The emailed code, the app's code or a
 *   recovery code completes it.
 * - Email that is not configured cannot carry a code: an account with no app
 *   then signs in with its password alone, and the server logs why.
 * - A browser can be trusted for 30 days, so the code is not asked every time.
 * - A sign-in from a browser the account has not used before emails the
 *   account (the first browser an account ever uses sets the baseline silently).
 *
 * Nothing here uses a library (Rule 1): HMAC, SHA-256 and randomness are
 * `crypto.subtle` / `crypto.getRandomValues`.
 */

import { Env, Session, User, UserRole } from "./types";
import { jsonError } from "./guard";
import { bufferToHex, parseCookies, sha256Hex, timingSafeEqual, verifyPassword } from "./auth";
import { clearLoginFailures, createSession, findTenantById, findUserById, getLockoutRemaining, recordLoginFailure, writeAuditLog } from "./db";
import { uniformBelow } from "./conversations";
import { mailConfigProblem, sendMail } from "./mail";
import { RouteContext } from "./signup";

/** How long a password-checked sign-in waits for its second factor. */
const CHALLENGE_SECONDS = 10 * 60;
/** Wrong codes one challenge accepts before the sign-in starts over. */
const CHALLENGE_ATTEMPTS = 5;
/** Emailed codes per challenge, and the wait between them. */
const EMAIL_CODES_PER_CHALLENGE = 3;
const EMAIL_CODE_GAP_SECONDS = 60;
/** How long "Trust this browser" skips the second factor. */
const TRUST_SECONDS = 30 * 24 * 3600;
const SESSION_SECONDS = 7 * 24 * 3600;
const TOTP_STEP_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const DEVICE_COOKIE = "labkiosk_device";
const ISSUER = "Lab Kiosk";

const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------- TOTP

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error("Not a base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The six-digit code for one 30-second step. */
export async function totpCode(secret: Uint8Array, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new Uint8Array(8);
  let rest = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

export function currentTotpStep(at = Date.now()): number {
  return Math.floor(at / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The step a code matches, one step either side of now allowed for clock
 * drift, and only a step later than the last one used (a code works once).
 */
async function matchTotp(secretBase32: string, code: string, lastStep: number): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const step = currentTotpStep();
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate <= lastStep) continue;
    if (timingSafeEqual(await totpCode(secret, candidate), code)) return candidate;
  }
  return null;
}

// ------------------------------------------------------------ storage

interface TwoFactorRow {
  user_id: string;
  totp_secret: string;
  enabled_at: number | null;
  last_totp_step: number;
  recovery_codes: string;
  created_at: number;
}

interface ChallengeRow {
  token_hash: string;
  user_id: string;
  tenant_id: string | null;
  role: UserRole;
  redirect: string;
  attempts: number;
  email_code_hash: string | null;
  email_codes_sent: number;
  email_code_sent_at: number | null;
  expires_at: number;
}

async function findTwoFactor(db: D1Database, userId: string): Promise<TwoFactorRow | null> {
  return db.prepare("SELECT * FROM user_two_factor WHERE user_id = ?").bind(userId).first<TwoFactorRow>();
}

/** True when the account has an authenticator app turned on. */
export async function hasTwoFactor(db: D1Database, userId: string): Promise<boolean> {
  return Boolean((await findTwoFactor(db, userId))?.enabled_at);
}

/** What sign-in asks an account for after its password. */
interface FactorState {
  /** The authenticator app's row, when one is turned on. */
  app: TwoFactorRow | null;
  /** An emailed code is asked for (or, with an app, offered). */
  email: boolean;
  /** The account cannot turn the emailed code off. */
  required: boolean;
}

async function factorState(db: D1Database, user: User): Promise<FactorState> {
  const row = await findTwoFactor(db, user.id);
  const required = user.role === "super_admin";
  return { app: row?.enabled_at ? row : null, email: required || Boolean(user.two_factor_email), required };
}

function recoveryHashes(row: TwoFactorRow): string[] {
  try {
    const list = JSON.parse(row.recovery_codes);
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === "string") : [];
  } catch {
    // A damaged list is an empty one: the codes cannot be checked, the app still works.
    return [];
  }
}

function newRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < 10; i++) code += RECOVERY_ALPHABET[uniformBelow(RECOVERY_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Check a code against the account: the app's code (moving the replay mark),
 * or a recovery code (used up). Returns how it was proved, or null.
 */
async function checkAccountCode(db: D1Database, row: TwoFactorRow, input: string): Promise<"totp" | "recovery" | null> {
  const code = input.replace(/\s+/g, "");
  if (/^\d{6}$/.test(code)) {
    const step = await matchTotp(row.totp_secret, code, row.last_totp_step);
    if (step === null) return null;
    // Conditional on the old mark, so two requests cannot both spend one code.
    const moved = await db
      .prepare("UPDATE user_two_factor SET last_totp_step = ? WHERE user_id = ? AND last_totp_step = ?")
      .bind(step, row.user_id, row.last_totp_step)
      .run();
    return (moved.meta?.changes ?? 0) > 0 ? "totp" : null;
  }
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 10) return null;
  const hash = await sha256Hex(`recovery:${normalized}`);
  const hashes = recoveryHashes(row);
  const index = hashes.findIndex((h) => timingSafeEqual(h, hash));
  if (index < 0) return null;
  const remaining = hashes.filter((_, i) => i !== index);
  const spent = await db
    .prepare("UPDATE user_two_factor SET recovery_codes = ? WHERE user_id = ? AND recovery_codes = ?")
    .bind(JSON.stringify(remaining), row.user_id, row.recovery_codes)
    .run();
  return (spent.meta?.changes ?? 0) > 0 ? "recovery" : null;
}

export async function purgeExpiredLoginChallenges(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM login_challenges WHERE expires_at < ?").bind(now()).run();
}

/** A password change ends every "trust this browser". */
export async function revokeTrustedBrowsers(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE user_devices SET trusted_until = NULL WHERE user_id = ?").bind(userId).run();
}

// ------------------------------------------------------------- cookies

export interface CookieOptions {
  domain?: string;
  secure: boolean;
  /** Builds the session cookie exactly as the rest of the Worker does. */
  sessionCookie: (token: string) => string;
}

function deviceCookie(token: string, options: CookieOptions): string {
  // Read only by the sign-in routes; a year is as long as browsers keep a cookie.
  const parts = [`${DEVICE_COOKIE}=${token}`, "Path=/api/auth", `Max-Age=${400 * 24 * 3600}`, "HttpOnly", "SameSite=Strict"];
  if (options.domain) parts.push(`Domain=.${options.domain.replace(/^\./, "")}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function deviceTokenFrom(request: Request): string | null {
  const value = parseCookies(request.headers.get("Cookie"))[DEVICE_COOKIE] || "";
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

// ------------------------------------------------------------- sign-in

interface SignInTarget {
  userId: string;
  tenantId: string | null;
  role: UserRole;
  redirect: string;
}

/**
 * The password checked out. Either sign in now (no second factor, or a
 * trusted browser) or answer with a challenge for the second step. An account
 * without an authenticator app is emailed its code straight away.
 */
export async function continueSignIn(ctx: RouteContext, cookies: CookieOptions, target: SignInTarget): Promise<Response> {
  const { db, env, request, jsonHeaders } = ctx;
  const user = await findUserById(db, target.userId);
  const state = user ? await factorState(db, user) : null;
  const mailProblem = mailConfigProblem(env);
  if (user && state && !state.app && state.email && mailProblem) {
    // The only second factor this account has cannot be delivered.
    console.error(`[Auth] ${mailProblem} Signing in without an emailed code.`);
  } else if (user && state && (state.app || state.email)) {
    const device = deviceTokenFrom(request);
    const trusted = device
      ? await db
          .prepare("SELECT 1 FROM user_devices WHERE user_id = ? AND token_hash = ? AND trusted_until > ?")
          .bind(target.userId, await sha256Hex(device), now())
          .first()
      : null;
    if (!trusted) {
      const token = bufferToHex(crypto.getRandomValues(new Uint8Array(32)));
      const tokenHash = await sha256Hex(token);
      const ts = now();
      await db
        .prepare(
          `INSERT INTO login_challenges (token_hash, user_id, tenant_id, role, redirect, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(tokenHash, target.userId, target.tenantId, target.role, target.redirect, ts + CHALLENGE_SECONDS, ts)
        .run();
      if (!state.app && !(await sendChallengeCode(env, db, tokenHash, user))) {
        await db.prepare("DELETE FROM login_challenges WHERE token_hash = ?").bind(tokenHash).run();
        return jsonError("The sign-in code could not be emailed. Try again in a moment.", 502, jsonHeaders);
      }
      return new Response(
        JSON.stringify({
          status: "two_factor",
          challenge: token,
          expiresIn: CHALLENGE_SECONDS,
          method: state.app ? "app" : "email",
          sentTo: state.app ? null : maskEmail(user.email)
        }),
        { headers: jsonHeaders }
      );
    }
  }
  return completeSignIn(ctx, cookies, target, { method: "password", trustBrowser: false });
}

/** Email a fresh code for a challenge. False when it could not be sent. */
async function sendChallengeCode(env: Env, db: D1Database, tokenHash: string, user: User): Promise<boolean> {
  const code = String(uniformBelow(1_000_000)).padStart(6, "0");
  await db
    .prepare("UPDATE login_challenges SET email_code_hash = ?, email_codes_sent = email_codes_sent + 1, email_code_sent_at = ? WHERE token_hash = ?")
    .bind(await sha256Hex(`${tokenHash}:${code}`), now(), tokenHash)
    .run();
  try {
    await sendMail(env, {
      to: user.email,
      toName: user.name,
      subject: `${code} is your Lab Kiosk sign-in code`,
      text:
        `Hello ${user.name},\n\nYour sign-in code is ${code}. It works for this sign-in only, for the next ten minutes.\n\n` +
        `If you did not just enter your password, someone else knows it: change it now, and keep this code to yourself.\n\nLab Kiosk`,
      template: { name: "code", code, purpose: "sign-in", minutes: CHALLENGE_SECONDS / 60, recipientName: user.name }
    });
    return true;
  } catch (err) {
    console.error("[Auth] Sending a sign-in code failed:", err);
    return false;
  }
}

async function completeSignIn(
  ctx: RouteContext,
  cookies: CookieOptions,
  target: SignInTarget,
  how: { method: "password" | "totp" | "email" | "recovery"; trustBrowser: boolean }
): Promise<Response> {
  const { db, env, request, jsonHeaders, clientIp } = ctx;
  const token = bufferToHex(crypto.getRandomValues(new Uint8Array(32)));
  await createSession(db, {
    token,
    user_id: target.userId,
    tenant_id: target.tenantId,
    role: target.role,
    expires_at: now() + SESSION_SECONDS
  });
  await writeAuditLog(db, {
    tenantId: target.tenantId,
    userId: target.userId,
    action: "auth.login",
    details: `role=${target.role}${how.method === "password" ? "" : ` second_factor=${how.method}`}`
  });

  // Remember this browser, and tell the account when it is a new one.
  const userAgent = (request.headers.get("User-Agent") || "").slice(0, 300);
  const device = deviceTokenFrom(request) || bufferToHex(crypto.getRandomValues(new Uint8Array(32)));
  const deviceHash = await sha256Hex(device);
  const ts = now();
  const known = await db
    .prepare("SELECT 1 FROM user_devices WHERE user_id = ? AND token_hash = ?")
    .bind(target.userId, deviceHash)
    .first();
  const anyKnown = known ? true : Boolean(await db.prepare("SELECT 1 FROM user_devices WHERE user_id = ? LIMIT 1").bind(target.userId).first());
  await db
    .prepare(
      `INSERT INTO user_devices (user_id, token_hash, trusted_until, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, token_hash) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         user_agent = excluded.user_agent,
         trusted_until = COALESCE(excluded.trusted_until, user_devices.trusted_until)`
    )
    .bind(target.userId, deviceHash, how.trustBrowser ? ts + TRUST_SECONDS : null, userAgent, ts, ts)
    .run();
  if (!known && anyKnown) await sendSignInAlert(env, db, target, { ip: clientIp, userAgent });

  const headers = new Headers(jsonHeaders);
  headers.append("Set-Cookie", cookies.sessionCookie(token));
  headers.append("Set-Cookie", deviceCookie(device, cookies));
  const tenant = target.tenantId ? await findTenantById(db, target.tenantId) : null;
  return new Response(JSON.stringify({ status: "ok", role: target.role, subdomain: tenant?.subdomain || null, redirect: target.redirect }), {
    headers
  });
}

async function sendSignInAlert(env: Env, db: D1Database, target: SignInTarget, from: { ip: string; userAgent: string }): Promise<void> {
  if (mailConfigProblem(env)) return;
  const user = await findUserById(db, target.userId);
  if (!user) return;
  const when = new Date().toISOString().replace("T", " ").slice(0, 16);
  const where = target.role === "super_admin" ? "the Super Admin console" : "your console under Settings";
  try {
    await sendMail(env, {
      to: user.email,
      toName: user.name,
      subject: "New sign-in to your Lab Kiosk account",
      text:
        `Hello ${user.name},\n\n` +
        `Your Lab Kiosk account was just signed in to from a browser it has not used before.\n\n` +
        `When: ${when} UTC\nIP address: ${from.ip}\nBrowser: ${from.userAgent || "unknown"}\n\n` +
        `If this was you, there is nothing to do.\n\n` +
        `If it was not, change your password now in ${where}, and turn on two-factor sign-in there. ` +
        `Changing the password signs every other browser out.\n\nLab Kiosk`,
      template: {
        name: "alert",
        title: "New sign-in to your account",
        lead: `Hello ${user.name}, your Lab Kiosk account was just signed in to from a browser it has not used before.`,
        details: [
          ["When", `${when} UTC`],
          ["IP address", from.ip],
          ["Browser", from.userAgent || "unknown"]
        ],
        advice:
          `If this was you, there is nothing to do. If it was not, change your password now in ${where}, and turn on two-factor sign-in there. ` +
          `Changing the password signs every other browser out.`
      }
    });
  } catch (err) {
    // The sign-in itself succeeded; only the notice failed.
    console.error("[Auth] Sending a sign-in alert failed:", err);
  }
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

async function findChallenge(db: D1Database, token: unknown): Promise<ChallengeRow | null> {
  const value = String(token ?? "");
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  const row = await db.prepare("SELECT * FROM login_challenges WHERE token_hash = ?").bind(await sha256Hex(value)).first<ChallengeRow>();
  return row && row.expires_at >= now() ? row : null;
}

const EXPIRED = "This sign-in has expired. Enter your password again.";

/** POST /api/auth/login/verify { challenge, code, trustBrowser? }: the second step. */
export async function handleLoginVerify(ctx: RouteContext, cookies: CookieOptions): Promise<Response> {
  const { db, request, jsonHeaders } = ctx;
  const body = await readJson<{ challenge?: unknown; code?: unknown; trustBrowser?: unknown }>(request);
  if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
  const challenge = await findChallenge(db, body.challenge);
  if (!challenge) return jsonError(EXPIRED, 401, jsonHeaders);
  const user = await findUserById(db, challenge.user_id);
  const state = user ? await factorState(db, user) : null;
  if (!user || !state || (!state.app && !state.email)) {
    await db.prepare("DELETE FROM login_challenges WHERE token_hash = ?").bind(challenge.token_hash).run();
    return jsonError(EXPIRED, 401, jsonHeaders);
  }
  const lockedFor = await getLockoutRemaining(db, user.email);
  if (lockedFor > 0) {
    return jsonError(`Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`, 429, jsonHeaders);
  }

  const code = String(body.code ?? "").trim().slice(0, 40);
  let method: "totp" | "email" | "recovery" | null = null;
  if (/^\d{6}$/.test(code) && challenge.email_code_hash) {
    const hash = await sha256Hex(`${challenge.token_hash}:${code}`);
    if (timingSafeEqual(hash, challenge.email_code_hash)) method = "email";
  }
  if (!method && code && state.app) method = await checkAccountCode(db, state.app, code);

  if (!method) {
    await recordLoginFailure(db, user.email);
    const attempts = challenge.attempts + 1;
    if (attempts >= CHALLENGE_ATTEMPTS) {
      await db.prepare("DELETE FROM login_challenges WHERE token_hash = ?").bind(challenge.token_hash).run();
      return jsonError("Too many wrong codes. Enter your password again.", 401, jsonHeaders);
    }
    await db.prepare("UPDATE login_challenges SET attempts = ? WHERE token_hash = ?").bind(attempts, challenge.token_hash).run();
    return jsonError("That code is not right. Check it and try again.", 400, jsonHeaders);
  }

  // One challenge, one session: the delete decides a race between two correct answers.
  const consumed = await db.prepare("DELETE FROM login_challenges WHERE token_hash = ?").bind(challenge.token_hash).run();
  if ((consumed.meta?.changes ?? 0) === 0) return jsonError(EXPIRED, 401, jsonHeaders);
  await clearLoginFailures(db, user.email);
  return completeSignIn(
    ctx,
    cookies,
    { userId: challenge.user_id, tenantId: challenge.tenant_id, role: challenge.role, redirect: challenge.redirect },
    { method, trustBrowser: body.trustBrowser === true }
  );
}

/** POST /api/auth/login/email-code { challenge }: email a code instead of using the app, or a new one. */
export async function handleLoginEmailCode(ctx: RouteContext): Promise<Response> {
  const { db, env, request, jsonHeaders } = ctx;
  const body = await readJson<{ challenge?: unknown }>(request);
  if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);
  const challenge = await findChallenge(db, body.challenge);
  if (!challenge) return jsonError(EXPIRED, 401, jsonHeaders);
  const problem = mailConfigProblem(env);
  if (problem) {
    console.error("[Auth]", problem);
    return jsonError("Email codes are not available right now. Use your authenticator app or a recovery code.", 503, jsonHeaders);
  }
  if (challenge.email_codes_sent >= EMAIL_CODES_PER_CHALLENGE) {
    return jsonError("No more codes can be sent for this sign-in. Enter your password again to start over.", 429, jsonHeaders);
  }
  const wait = challenge.email_code_sent_at ? challenge.email_code_sent_at + EMAIL_CODE_GAP_SECONDS - now() : 0;
  if (wait > 0) return jsonError(`Wait ${wait} seconds before asking for another code.`, 429, jsonHeaders);
  const user = await findUserById(db, challenge.user_id);
  if (!user) return jsonError(EXPIRED, 401, jsonHeaders);

  if (!(await sendChallengeCode(env, db, challenge.token_hash, user))) {
    return jsonError("The code could not be sent. Try again in a moment, or use your authenticator app or a recovery code.", 502, jsonHeaders);
  }
  return new Response(JSON.stringify({ status: "ok", sentTo: maskEmail(user.email) }), { headers: jsonHeaders });
}

/** `j•••@example.org`: enough to recognise the address, not to learn it. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `${email[0]}•••${email.slice(at)}` : "your email address";
}

// ------------------------------------------------- managing your own factor

/**
 * `/api/auth/two-factor...` for the signed-in account (any role):
 * - GET: whether emailed codes and the app are on, and how many recovery codes are left
 * - POST /email { password, enabled }: turn the emailed code on or off (never off for a super admin)
 * - POST /setup { password }: a new secret to add to the app (not yet on)
 * - POST /enable { code }: turn it on with the first code; returns the recovery codes once
 * - POST /recovery-codes { password, code }: replace the recovery codes
 * - POST /disable { password, code }: turn it off
 */
export async function handleTwoFactorRoute(ctx: RouteContext, sessionToken: string | null): Promise<Response> {
  const { db, env, request, jsonHeaders, url } = ctx;
  const session: Session | null = ctx.session;
  if (!session) return jsonError("Authentication required", 401, jsonHeaders);
  const user = await findUserById(db, session.user_id);
  if (!user) return jsonError("Authentication required", 401, jsonHeaders);
  const action = url.pathname.slice("/api/auth/two-factor".length).replace(/^\//, "");
  const row = await findTwoFactor(db, user.id);
  const state = await factorState(db, user);
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: jsonHeaders });

  if (action === "") {
    if (request.method !== "GET") return jsonError("Method not allowed", 405, jsonHeaders);
    return json({
      enabled: Boolean(row?.enabled_at),
      enabledAt: row?.enabled_at ?? null,
      recoveryCodesLeft: row?.enabled_at ? recoveryHashes(row).length : 0,
      email: user.email,
      emailCodes: state.email,
      required: state.required,
      mailAvailable: !mailConfigProblem(env)
    });
  }
  if (!["email", "setup", "enable", "disable", "recovery-codes"].includes(action)) return jsonError("Not Found", 404, jsonHeaders);
  if (request.method !== "POST") return jsonError("Method not allowed", 405, jsonHeaders);
  const body = await readJson<{ password?: unknown; code?: unknown; enabled?: unknown }>(request);
  if (!body) return jsonError("The request body must be JSON", 400, jsonHeaders);

  const lockedFor = await getLockoutRemaining(db, user.email);
  if (lockedFor > 0) {
    return jsonError(`Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`, 429, jsonHeaders);
  }
  /** Changes to the factor itself need the password again: a borrowed session is not enough. */
  const passwordOk = async () => {
    const ok = await verifyPassword(String(body.password ?? ""), user.password_hash, user.salt);
    if (!ok) await recordLoginFailure(db, user.email);
    return ok;
  };
  const audit = (action: string) => writeAuditLog(db, { tenantId: session.tenant_id || null, userId: user.id, action });

  if (action === "email") {
    if (typeof body.enabled !== "boolean") return jsonError("Say whether emailed codes are on or off", 400, jsonHeaders);
    const enable = body.enabled;
    if (!enable && state.required) return jsonError("A platform administrator always signs in with a code", 409, jsonHeaders);
    if (enable && mailConfigProblem(env)) return jsonError("Email is not set up on this server, so codes cannot be sent", 503, jsonHeaders);
    if (!(await passwordOk())) return jsonError("The password is not correct", 400, jsonHeaders);
    if (Boolean(user.two_factor_email) !== enable) {
      await db.prepare("UPDATE users SET two_factor_email = ? WHERE id = ?").bind(enable ? 1 : 0, user.id).run();
      if (enable) {
        // Other browsers signed in with the password alone are signed out.
        await db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").bind(user.id, sessionToken || "").run();
      } else if (!state.app) {
        // Nothing is asked after the password any more: trusted browsers mean nothing.
        await db.batch([
          db.prepare("DELETE FROM login_challenges WHERE user_id = ?").bind(user.id),
          db.prepare("UPDATE user_devices SET trusted_until = NULL WHERE user_id = ?").bind(user.id)
        ]);
      }
      await audit(enable ? "auth.two_factor_email_enable" : "auth.two_factor_email_disable");
    }
    return json({ status: "ok", emailCodes: enable || state.required });
  }

  if (action === "setup") {
    if (row?.enabled_at) return jsonError("Two-factor sign-in is already on. Turn it off first to move it to a new app.", 409, jsonHeaders);
    if (!(await passwordOk())) return jsonError("The password is not correct", 400, jsonHeaders);
    const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    await db
      .prepare(
        `INSERT INTO user_two_factor (user_id, totp_secret, enabled_at, last_totp_step, recovery_codes, created_at)
         VALUES (?, ?, NULL, 0, '[]', ?)
         ON CONFLICT(user_id) DO UPDATE SET totp_secret = excluded.totp_secret, last_totp_step = 0, recovery_codes = '[]', created_at = excluded.created_at`
      )
      .bind(user.id, secret, now())
      .run();
    const label = encodeURIComponent(`${ISSUER}:${user.email}`);
    return json({
      secret,
      otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`
    });
  }

  if (action === "enable") {
    if (!row) return jsonError("Start the setup first", 409, jsonHeaders);
    if (row.enabled_at) return jsonError("Two-factor sign-in is already on", 409, jsonHeaders);
    const code = String(body.code ?? "").replace(/\s+/g, "");
    const step = await matchTotp(row.totp_secret, code, row.last_totp_step);
    if (step === null) return jsonError("That code is not right. Check the time on your device and try again.", 400, jsonHeaders);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => sha256Hex(`recovery:${normalizeRecoveryCode(c)}`)));
    const enabled = await db
      .prepare("UPDATE user_two_factor SET enabled_at = ?, last_totp_step = ?, recovery_codes = ? WHERE user_id = ? AND enabled_at IS NULL")
      .bind(now(), step, JSON.stringify(hashes), user.id)
      .run();
    if ((enabled.meta?.changes ?? 0) === 0) return jsonError("Two-factor sign-in is already on", 409, jsonHeaders);
    // Other browsers signed in with the password alone are signed out.
    await db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").bind(user.id, sessionToken || "").run();
    await audit("auth.two_factor_enable");
    return json({ status: "ok", recoveryCodes: codes });
  }

  // Turning it off or replacing the codes: the password and a current code.
  if (!row?.enabled_at) return jsonError("Two-factor sign-in is not on", 409, jsonHeaders);
  if (!(await passwordOk())) return jsonError("The password is not correct", 400, jsonHeaders);
  const proved = await checkAccountCode(db, row, String(body.code ?? "").trim().slice(0, 40));
  if (!proved) {
    await recordLoginFailure(db, user.email);
    return jsonError("That code is not right", 400, jsonHeaders);
  }
  await clearLoginFailures(db, user.email);

  if (action === "recovery-codes") {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => sha256Hex(`recovery:${normalizeRecoveryCode(c)}`)));
    await db.prepare("UPDATE user_two_factor SET recovery_codes = ? WHERE user_id = ?").bind(JSON.stringify(hashes), user.id).run();
    await audit("auth.two_factor_recovery_codes");
    return json({ status: "ok", recoveryCodes: codes });
  }

  await db.batch([
    db.prepare("DELETE FROM user_two_factor WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM login_challenges WHERE user_id = ?").bind(user.id),
    db.prepare("UPDATE user_devices SET trusted_until = NULL WHERE user_id = ?").bind(user.id)
  ]);
  await audit("auth.two_factor_disable");
  return json({ status: "ok" });
}

/** True when the path is one of the account's two-factor routes. */
export function isTwoFactorRoute(path: string): boolean {
  return path === "/api/auth/two-factor" || /^\/api\/auth\/two-factor\/[a-z-]+$/.test(path);
}
