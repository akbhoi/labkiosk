/**
 * Phone numbers at registration, proved by a code Firebase texts to them.
 *
 * Firebase only sends the SMS and checks the code: the registration page asks
 * Firebase Authentication to text the number, the registrant types the code,
 * and Firebase hands the page an ID token, a JWT Google signs that names the
 * phone number. `POST /api/auth/register` sends that token with the form, and
 * this module checks it here (signature, issuer, audience, age, provider and
 * number) before the phone is recorded as verified. Nothing is trusted because
 * the page says so, and Firebase holds no session or account of ours.
 *
 * Optional, and all or nothing (Rule 10): it is on when FIREBASE_PROJECT_ID,
 * FIREBASE_API_KEY and FIREBASE_AUTH_DOMAIN are all set, and then every
 * registration needs a verified phone. Some but not all of them set is a
 * mistake, and registration refuses rather than run without the check.
 *
 * Nothing here uses a library (Rule 1): RS256 is `crypto.subtle`.
 */

import { Env } from "./types";

/** Google's public keys for Firebase ID tokens, as a JSON Web Key Set. */
export const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
/** The Firebase Auth web SDK the registration page loads, pinned (src/ui_landing.ts). */
export const FIREBASE_SDK_VERSION = "12.19.0";
export const FIREBASE_SDK_ORIGIN = "https://www.gstatic.com";

/** How old a phone sign-in may be when the registration arrives with it. */
const MAX_AUTH_AGE_SECONDS = 15 * 60;
/** Clock difference between this edge and Google tolerated on iat and exp. */
const CLOCK_SKEW_SECONDS = 60;
/** How long the keys are kept when Google's answer names no max-age. */
const DEFAULT_KEYS_SECONDS = 3600;
/** A Firebase ID token is a little over 1 KB; anything far larger is not one. */
const MAX_TOKEN_LENGTH = 4096;

export interface FirebaseConfig {
  projectId: string;
  apiKey: string;
  authDomain: string;
}

function setting(value: string | undefined): string {
  return (value || "").trim();
}

/** The three public values the registration page needs, when phone verification is on. Else null. */
export function firebaseConfig(env: Env): FirebaseConfig | null {
  const projectId = setting(env.FIREBASE_PROJECT_ID);
  const apiKey = setting(env.FIREBASE_API_KEY);
  const authDomain = setting(env.FIREBASE_AUTH_DOMAIN);
  return projectId && apiKey && authDomain ? { projectId, apiKey, authDomain } : null;
}

/** Why the Firebase settings are wrong, or null when they are all set and well formed, or all unset. */
export function firebaseConfigProblem(env: Env): string | null {
  const values = [env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY, env.FIREBASE_AUTH_DOMAIN].map(setting);
  const set = values.filter(Boolean).length;
  if (set === 0) return null;
  if (set < 3) {
    return "Phone verification is half configured: set FIREBASE_PROJECT_ID, FIREBASE_API_KEY and FIREBASE_AUTH_DOMAIN, or none of them (docs/DEPLOYMENT.md).";
  }
  const [projectId, apiKey, authDomain] = values;
  // They are written into the page and the CSP, so only the shapes Firebase uses are accepted.
  if (!/^[a-z0-9-]{4,40}$/.test(projectId)) return "FIREBASE_PROJECT_ID must be the project's id: lowercase letters, digits and hyphens.";
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(apiKey)) return "FIREBASE_API_KEY must be the web API key from the Firebase console.";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(authDomain)) return "FIREBASE_AUTH_DOMAIN must be a host name, such as <project>.firebaseapp.com.";
  return null;
}

// ------------------------------------------------------------------- keys

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

let cachedKeys: { keys: Map<string, CryptoKey>; until: number } | null = null;

/** Forget the cached keys (tests). */
export function resetFirebaseKeys(): void {
  cachedKeys = null;
}

function maxAge(cacheControl: string | null): number {
  const match = /max-age=(\d+)/.exec(cacheControl || "");
  const seconds = match ? Number(match[1]) : DEFAULT_KEYS_SECONDS;
  return Math.min(Math.max(seconds, 60), 24 * 3600);
}

async function firebaseKeys(fetcher: typeof fetch, nowSeconds: number, forceRefresh: boolean): Promise<Map<string, CryptoKey>> {
  if (cachedKeys && !forceRefresh && cachedKeys.until > nowSeconds) return cachedKeys.keys;
  const res = await fetcher(FIREBASE_JWKS_URL);
  if (!res.ok) throw new Error(`Google's key set answered ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys || []) {
    if (!jwk.kid || jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    keys.set(jwk.kid, key);
  }
  if (!keys.size) throw new Error("Google's key set holds no RSA keys");
  cachedKeys = { keys, until: nowSeconds + maxAge(res.headers.get("Cache-Control")) };
  return keys;
}

// ------------------------------------------------------------------ tokens

function base64urlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function base64urlJson(value: string): Record<string, unknown> | null {
  const bytes = base64urlBytes(value);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type PhoneTokenResult =
  | { ok: true; phone: string }
  | { ok: false; reason: "malformed" | "signature" | "claims" | "stale" | "mismatch" }
  | { ok: false; reason: "unavailable"; detail: string };

/**
 * Check a Firebase ID token from a phone sign-in against the number the form
 * names. `unavailable` means Google's keys could not be fetched: the token
 * was not judged, and the caller should ask the registrant to try again.
 */
export async function verifyPhoneToken(
  config: FirebaseConfig,
  token: unknown,
  expectedPhone: string,
  options: { fetcher?: typeof fetch; now?: number } = {}
): Promise<PhoneTokenResult> {
  const fetcher = options.fetcher || fetch;
  const nowSeconds = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const header = base64urlJson(parts[0]);
  const claims = base64urlJson(parts[1]);
  const signature = base64urlBytes(parts[2]);
  if (!header || !claims || !signature || header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, reason: "malformed" };
  }

  let key: CryptoKey | undefined;
  try {
    key = (await firebaseKeys(fetcher, nowSeconds, false)).get(header.kid);
    // Google rotates its keys; a token signed by a newer one than the cached set is checked against a fresh set.
    if (!key) key = (await firebaseKeys(fetcher, nowSeconds, true)).get(header.kid);
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!key) return { ok: false, reason: "signature" };
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!valid) return { ok: false, reason: "signature" };

  const firebase = claims.firebase as { sign_in_provider?: unknown } | undefined;
  const number = (key: string) => (typeof claims[key] === "number" ? (claims[key] as number) : NaN);
  const iat = number("iat");
  const exp = number("exp");
  const authTime = number("auth_time");
  if (
    claims.iss !== `https://securetoken.google.com/${config.projectId}` ||
    claims.aud !== config.projectId ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    !firebase ||
    firebase.sign_in_provider !== "phone" ||
    !(iat <= nowSeconds + CLOCK_SKEW_SECONDS) ||
    !(exp > nowSeconds - CLOCK_SKEW_SECONDS) ||
    !(authTime <= nowSeconds + CLOCK_SKEW_SECONDS)
  ) {
    return { ok: false, reason: "claims" };
  }
  if (authTime < nowSeconds - MAX_AUTH_AGE_SECONDS) return { ok: false, reason: "stale" };
  if (claims.phone_number !== expectedPhone) return { ok: false, reason: "mismatch" };
  return { ok: true, phone: expectedPhone };
}

/** What the registrant is told when a token is refused. */
export function phoneTokenMessage(result: Exclude<PhoneTokenResult, { ok: true }>): { message: string; status: number } {
  switch (result.reason) {
    case "unavailable":
      return { message: "We could not check your phone number just now. Please try again in a moment.", status: 503 };
    case "stale":
      return { message: "The phone check has expired. Send a new text message code and enter it.", status: 400 };
    case "mismatch":
      return { message: "The phone number was changed after it was checked. Send a new text message code to this number.", status: 400 };
    default:
      return { message: "Verify your phone number with the code we text to it.", status: 400 };
  }
}
