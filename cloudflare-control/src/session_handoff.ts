/**
 * Host-only sessions, and handing a sign-in from one host to another.
 *
 * The session cookie carries no Domain attribute, so it is sent only to the host that set it:
 * an organization's subdomain never sees the platform's (or another organization's) session, and
 * no subdomain can set or overwrite another host's cookie. On HTTPS it is a `__Host-` cookie,
 * which browsers refuse unless it is Secure, Path=/ and host-only.
 *
 * Signing in on the platform apex for a console on another host (an organization subdomain or
 * custom domain, or the demo) therefore cannot set the cookie there. The sign-in instead creates
 * the session, seals its token into a short-lived handoff code bound to the destination host, and
 * sends the browser to `/api/auth/handoff` on that host. That route opens the code, replaces the
 * session with a new one (so the code works once) and sets the cookie on its own host.
 */

import type { Env, Session } from "./types";
import { bufferToHex } from "./auth";
import { createSession, deleteSession, getSession } from "./db";

export const SESSION_COOKIE_SECURE = "__Host-labkiosk_session";
/** Plain HTTP (local development) cannot carry a `__Host-` cookie. */
export const SESSION_COOKIE_PLAIN = "labkiosk_session";
/** An organization's console session. */
export const SESSION_SECONDS = 7 * 24 * 3600;
/** The platform super admin's: it can act on every organization, so it lasts a working day. */
export const SUPER_ADMIN_SESSION_SECONDS = 12 * 3600;
/** How long a handoff code is accepted: it is followed by a redirect at once. */
const HANDOFF_SECONDS = 60;
export const HANDOFF_PATH = "/api/auth/handoff";

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}

export function sessionSecondsFor(role: string): number {
  return role === "super_admin" ? SUPER_ADMIN_SESSION_SECONDS : SESSION_SECONDS;
}

export function createSessionCookie(token: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  const parts = [`${sessionCookieName(options.secure)}=${token}`, "Path=/", `Max-Age=${options.maxAgeSeconds}`, "HttpOnly", "SameSite=Lax"];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The cookies a sign-out (or a sign-in) sends to end a session here: this host's, and the
 * parent-domain cookie earlier releases set for every subdomain, so none lingers.
 */
export function clearSessionCookies(options: { secure: boolean; legacyDomain?: string }): string[] {
  const cleared = [[`${sessionCookieName(options.secure)}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"]];
  if (options.legacyDomain) {
    cleared.push([`${SESSION_COOKIE_PLAIN}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax", `Domain=.${options.legacyDomain.replace(/^\./, "")}`]);
  }
  return cleared.map((parts) => (options.secure ? [...parts, "Secure"] : parts).join("; "));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** AES-GCM key for handoff codes, derived from the deployment's PASSWORD_PEPPER. */
async function handoffKey(pepper: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("labkiosk session handoff v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

interface HandoffClaims {
  /** The session to hand over. Sealed: a session token is also a bearer credential. */
  t: string;
  /** The only host that may open it. */
  h: string;
  /** Unix seconds after which it is refused. */
  e: number;
}

export async function sealHandoff(pepper: string, token: string, host: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const claims: HandoffClaims = { t: token, h: host.toLowerCase(), e: now + HANDOFF_SECONDS };
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await handoffKey(pepper), new TextEncoder().encode(JSON.stringify(claims)))
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return base64url(out);
}

/** The session token a handoff code carries, or null when it is forged, expired or for another host. */
export async function openHandoff(pepper: string, code: string, host: string, now = Math.floor(Date.now() / 1000)): Promise<string | null> {
  const bytes = fromBase64url(code);
  if (!bytes || bytes.length < 12 + 16) return null;
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await handoffKey(pepper), bytes.slice(12));
  } catch {
    // A tampered or foreign code fails authentication; that is the expected refusal.
    return null;
  }
  let claims: Partial<HandoffClaims>;
  try {
    claims = JSON.parse(new TextDecoder().decode(plain)) as Partial<HandoffClaims>;
  } catch {
    return null;
  }
  if (typeof claims.t !== "string" || typeof claims.h !== "string" || typeof claims.e !== "number") return null;
  if (claims.h !== host.toLowerCase() || claims.e < now) return null;
  return claims.t;
}

/**
 * Where a sign-in on `request` should send the browser for `redirect`, and whether the session
 * cookie belongs on this host. A redirect to another host becomes a handoff through that host.
 */
export async function signInDestination(
  env: Env,
  request: Request,
  token: string,
  redirect: string,
  pepper: string
): Promise<{ redirect: string; cookieHere: boolean }> {
  const here = new URL(request.url);
  const hereHost = (request.headers.get("host") || here.host).toLowerCase();
  let target: URL;
  try {
    target = new URL(redirect, `${here.protocol}//${hereHost}`);
  } catch {
    return { redirect: "/", cookieHere: true };
  }
  if (target.host.toLowerCase() === hereHost) return { redirect, cookieHere: true };
  // Only the platform's own hosts are handed a session. postLoginRedirect builds these, never the client.
  const base = (env.DEFAULT_DOMAIN || "").replace(/^\./, "").toLowerCase();
  if (target.protocol !== "https:" || !base || !(target.hostname === base || target.hostname.endsWith("." + base))) {
    throw new Error(`Refusing to hand a session to ${target.host}`);
  }
  const code = await sealHandoff(pepper, token, target.host);
  const next = target.pathname + target.search;
  return {
    redirect: `${target.protocol}//${target.host}${HANDOFF_PATH}?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`,
    cookieHere: false
  };
}

/** A same-host path to continue to; anything else falls back to the console. */
function safeNext(raw: string | null): string {
  const next = raw || "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/admin";
}

/**
 * GET /api/auth/handoff: open the code, swap its session for a new one so the code is spent, and
 * set this host's cookie. Any failure lands on this host's sign-in page with no cookie.
 */
export async function handleSessionHandoff(
  db: D1Database,
  request: Request,
  url: URL,
  options: { pepper: string; secure: boolean; legacyDomain?: string }
): Promise<Response> {
  const host = (request.headers.get("host") || url.host).toLowerCase();
  const token = await openHandoff(options.pepper, url.searchParams.get("code") || "", host);
  const session: Session | null = token ? await getSession(db, token) : null;
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (!token || !session) {
    headers.set("Location", "/?signin=expired");
    return new Response(null, { status: 302, headers });
  }
  await deleteSession(db, token);
  const fresh = bufferToHex(crypto.getRandomValues(new Uint8Array(32)));
  await createSession(db, { ...session, token: fresh });
  const maxAge = Math.max(0, session.expires_at - Math.floor(Date.now() / 1000));
  headers.append("Set-Cookie", createSessionCookie(fresh, { secure: options.secure, maxAgeSeconds: maxAge }));
  for (const cleared of clearSessionCookies({ secure: options.secure, legacyDomain: options.legacyDomain }).slice(1)) {
    headers.append("Set-Cookie", cleared);
  }
  headers.set("Location", safeNext(url.searchParams.get("next")));
  return new Response(null, { status: 302, headers });
}
