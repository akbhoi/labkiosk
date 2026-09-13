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
  // Constant time comparison
  if (hashHex.length !== storedHashHex.length) return false;
  let match = 0;
  for (let i = 0; i < hashHex.length; i++) {
    match |= hashHex.charCodeAt(i) ^ storedHashHex.charCodeAt(i);
  }
  return match === 0;
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
export function createSessionCookie(token: string, maxAgeSeconds: number = 7 * 24 * 3600): string {
  return `labkiosk_session=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax`;
}

/**
 * Build expired Set-Cookie string to log out
 */
export function clearSessionCookie(): string {
  return "labkiosk_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";
}
