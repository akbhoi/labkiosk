/**
 * Authentication & Cryptography Utilities
 * Uses standard Web Crypto API (supported natively in Cloudflare Workers & Node 18+)
 */

const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 256;

// Convert Uint8Array buffer to hex string
export function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Convert hex string to Uint8Array buffer
export function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Stored password hashes are PBKDF2-HMAC-SHA256 (100 000 iterations, the most Workers'
 * crypto.subtle allows) under a per-user 32-byte salt, then HMAC-SHA256 under the
 * PASSWORD_PEPPER secret. The pepper never reaches D1, so a leaked database export cannot be
 * cracked offline without it. Peppered hashes carry this prefix; older bare PBKDF2 hashes are
 * still accepted and are wrapped in place by `pepperLegacyHash()` (the hourly cron), which
 * needs no password because the HMAC is over the PBKDF2 output.
 */
export const PEPPERED_HASH_PREFIX = "p1$";
/** The shortest PASSWORD_PEPPER accepted: 32 characters, e.g. `openssl rand -hex 32` gives 64. */
export const MIN_PEPPER_LENGTH = 32;
/** Local development and tests only; a deployed worker refuses to start without its own secret. */
const LOCAL_DEVELOPMENT_PEPPER = "labkiosk-local-development-pepper-not-for-production";

/** The pepper this deployment hashes passwords with. Throws when production has none. */
export function passwordPepper(env: { PASSWORD_PEPPER?: string; ALLOW_LOCAL_DB?: string }): string {
  const pepper = env.PASSWORD_PEPPER || "";
  if (pepper.length >= MIN_PEPPER_LENGTH) return pepper;
  if (!pepper && env.ALLOW_LOCAL_DB === "1") return LOCAL_DEVELOPMENT_PEPPER;
  throw new Error(
    `PASSWORD_PEPPER must be set as a Wrangler secret of at least ${MIN_PEPPER_LENGTH} characters (\`openssl rand -hex 32 | npx wrangler secret put PASSWORD_PEPPER\`). Losing it signs every user out of their password, so keep a copy with your other secrets.`
  );
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, [
    "deriveBits"
  ]);
  return await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, passwordKey, KEY_LENGTH);
}

async function pepperBytes(pepper: string, bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return PEPPERED_HASH_PREFIX + bufferToHex(await crypto.subtle.sign("HMAC", key, bytes));
}

/** Hash a password with a fresh (or the given) salt, peppered. */
export async function hashPassword(password: string, pepper: string, saltHex?: string): Promise<{ hashHex: string; saltHex: string }> {
  const salt = saltHex ? hexToBuffer(saltHex) : crypto.getRandomValues(new Uint8Array(32));
  return { hashHex: await pepperBytes(pepper, await pbkdf2(password, salt)), saltHex: bufferToHex(salt) };
}

/** Verify a password against a stored hash, peppered or (until the cron wraps it) bare PBKDF2. */
export async function verifyPassword(password: string, storedHashHex: string, storedSaltHex: string, pepper: string): Promise<boolean> {
  const derived = await pbkdf2(password, hexToBuffer(storedSaltHex));
  if (storedHashHex.startsWith(PEPPERED_HASH_PREFIX)) {
    return timingSafeEqual(await pepperBytes(pepper, derived), storedHashHex);
  }
  return timingSafeEqual(bufferToHex(derived), storedHashHex);
}

/** The peppered form of a bare PBKDF2 hash, or null when it is already peppered or not one. */
export async function pepperLegacyHash(storedHashHex: string, pepper: string): Promise<string | null> {
  if (storedHashHex.startsWith(PEPPERED_HASH_PREFIX) || !/^[0-9a-f]{64}$/.test(storedHashHex)) return null;
  return await pepperBytes(pepper, hexToBuffer(storedHashHex));
}

/**
 * Length-independent, content-constant-time string comparison.
 * Used for every secret comparison: password hashes and enrollment keys.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** SHA-256 of a UTF-8 string, hex encoded. Used to store device tokens at rest. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bufferToHex(digest);
}

/** Opaque 256-bit bearer token issued to an enrolled workstation. */
export function generateDeviceToken(): string {
  return bufferToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The characters an enrollment key is made of: a Crockford-style alphabet with
 * the glyphs that are misread (I, L, O, U, 0, 1) removed.
 */
export const ENROLLMENT_KEY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
/** Characters in a key, hyphens aside: nineteen random ones and the check character. */
export const ENROLLMENT_KEY_LENGTH = 20;

/**
 * The check character for the characters before it: the Luhn algorithm over
 * this alphabet (Luhn mod N). The workstation recomputes it as the key is
 * typed, so one wrong character, or two neighbours swapped, is caught there
 * and never sent. It detects mistakes; it is not a secret and adds no entropy.
 *
 * The wizard (`enrollmentKeyCheckCharacter` in wizard.html) and the agent
 * (`enrollment_key_check_character` in agent.py) carry the same algorithm, and
 * tests on both sides hold them to the same vectors.
 */
export function enrollmentKeyCheckCharacter(payload: string): string {
  const n = ENROLLMENT_KEY_ALPHABET.length;
  let factor = 2;
  let sum = 0;
  for (let i = payload.length - 1; i >= 0; i--) {
    const code = ENROLLMENT_KEY_ALPHABET.indexOf(payload[i]);
    if (code < 0) throw new Error("Not an enrollment key character");
    const addend = factor * code;
    sum += Math.floor(addend / n) + (addend % n);
    factor = factor === 2 ? 1 : 2;
  }
  return ENROLLMENT_KEY_ALPHABET[(n - (sum % n)) % n];
}

/** True for a key of the shape issued here: four groups of five whose last character checks the rest. */
export function isEnrollmentKey(key: string): boolean {
  const chars = String(key || "").split("-");
  if (chars.length !== 4 || chars.some((group) => group.length !== 5)) return false;
  const flat = chars.join("");
  for (const ch of flat) if (!ENROLLMENT_KEY_ALPHABET.includes(ch)) return false;
  return enrollmentKeyCheckCharacter(flat.slice(0, -1)) === flat[flat.length - 1];
}

/**
 * Human-transcribable per-organization enrollment key: nineteen random
 * characters and a check character, grouped in fives for reading aloud in a room.
 */
export function generateEnrollmentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ENROLLMENT_KEY_LENGTH - 1));
  const payload = Array.from(bytes, (b) => ENROLLMENT_KEY_ALPHABET[b % ENROLLMENT_KEY_ALPHABET.length]).join("");
  const chars = payload + enrollmentKeyCheckCharacter(payload);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5)).join("-");
}

/**
 * Minimum password policy enforced server-side.
 * Returns null when acceptable, otherwise the reason to show the user.
 */
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string" || password.length < 12) {
    return "Password must be at least 12 characters long";
  }
  if (password.length > 200) {
    return "Password must be 200 characters or fewer";
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must contain both letters and numbers";
  }
  return null;
}

const PWNED_PASSWORDS_RANGE = "https://api.pwnedpasswords.com/range/";
const PWNED_PASSWORDS_TIMEOUT_MS = 3000;

/**
 * Whether a password appears in Have I Been Pwned's breached-password corpus.
 *
 * k-anonymity: only the first five hex characters of the password's SHA-1 leave the worker,
 * and `Add-Padding` hides how many suffixes came back. `BREACHED_PASSWORD_CHECK=off` turns the
 * check off (tests do; a deployment that may not call out can too). If the service cannot be
 * reached the password is allowed and the failure logged: an outage there must not stop sign-up
 * or a password change.
 */
export async function breachedPasswordProblem(
  password: string,
  env: { BREACHED_PASSWORD_CHECK?: string },
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  if (env.BREACHED_PASSWORD_CHECK === "off") return null;
  const digest = bufferToHex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password))).toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  let body: string;
  try {
    const res = await fetcher(PWNED_PASSWORDS_RANGE + prefix, {
      headers: { "Add-Padding": "true", "User-Agent": "labkiosk-controller" },
      signal: AbortSignal.timeout(PWNED_PASSWORDS_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.text();
  } catch (err) {
    console.warn(`[Worker] Breached-password check unavailable, password allowed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  for (const line of body.split("\n")) {
    const [candidate, count] = line.trim().split(":");
    // Padding entries carry a count of 0.
    if (candidate === suffix && Number(count) > 0) {
      return "This password has appeared in a data breach. Please choose a different one.";
    }
  }
  return null;
}

/** Loose RFC 5322 shape check; the point is to reject garbage, not to validate deliverability. */
export function isPlausibleEmail(value: unknown): boolean {
  const email = String(value ?? "").trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** Per-response CSP nonce: 128 random bits, base64 so it is safe inside an attribute. */
export function generateNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * Generate cryptographically secure random session token (64 hex characters)
 */
export function generateSessionToken(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return bufferToHex(randomBytes);
}

/**
 * Parse Cookie header into key-value map
 */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [name, ...rest] = pair.trim().split("=");
    if (name && rest.length > 0) {
      cookies[name] = decodeURIComponent(rest.join("="));
    }
  }
  return cookies;
}

