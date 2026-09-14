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
 * Hash password with PBKDF2-HMAC-SHA256 and unique 32-byte salt
 */
export async function hashPassword(
  password: string,
  saltHex?: string
): Promise<{ hashHex: string; saltHex: string }> {
  const salt = saltHex ? hexToBuffer(saltHex) : crypto.getRandomValues(new Uint8Array(32));
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    passwordKey,
    KEY_LENGTH
  );

  return {
    hashHex: bufferToHex(derivedBits),
    saltHex: bufferToHex(salt)
  };
}

/**
 * Verify plaintext password against stored hash & salt
 */
export async function verifyPassword(
  password: string,
  storedHashHex: string,
  storedSaltHex: string
): Promise<boolean> {
  const { hashHex } = await hashPassword(password, storedSaltHex);
  return timingSafeEqual(hashHex, storedHashHex);
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
 * Human-transcribable per-school enrollment key.
 * 20 characters from a Crockford-style alphabet with the ambiguous glyphs
 * (I, L, O, U, 0, 1) removed, grouped for reading aloud in a classroom.
 */
export function generateEnrollmentKey(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
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

/**
 * Build HttpOnly Set-Cookie string for session
 */
export function createSessionCookie(
  token: string,
  options: { maxAgeSeconds?: number; domain?: string; secure?: boolean } = {}
): string {
  const { maxAgeSeconds = 7 * 24 * 3600, domain, secure = true } = options;
  const parts = [
    `labkiosk_session=${token}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax"
  ];
  // Scope to the parent domain so a session created on labkiosk.akbhoi.com is still sent
  // to greenwood.labkiosk.akbhoi.com, which is where the teacher console actually lives.
  if (domain) parts.push(`Domain=.${domain.replace(/^\./, "")}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Build expired Set-Cookie string to log out
 */
export function clearSessionCookie(options: { domain?: string; secure?: boolean } = {}): string {
  const { domain, secure = true } = options;
  const parts = ["labkiosk_session=", "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (domain) parts.push(`Domain=.${domain.replace(/^\./, "")}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
