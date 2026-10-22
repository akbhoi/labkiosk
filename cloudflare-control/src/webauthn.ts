/**
 * Passkeys (WebAuthn Level 2) as a sign-in factor, verified without a library (Rule 1).
 *
 * - Registration reads the authenticator data out of the attestation object and keeps the
 *   credential's public key. Attestation is requested as "none": the platform does not decide
 *   which authenticators people may use, so an attestation statement is not checked.
 * - A sign-in checks the client data (type, challenge, origin), the relying party's hash, the
 *   user-presence flag, the signature over `authenticatorData || SHA-256(clientDataJSON)`, and
 *   that the signature counter did not go backwards.
 * - ES256 (ECDSA P-256, what nearly every passkey uses) and RS256 (some Windows Hello keys) are
 *   accepted; both verify with `crypto.subtle`.
 *
 * The relying party is the platform domain on every host under it, so one passkey works on the
 * apex and on any organization subdomain; a custom domain is its own relying party.
 */

import type { Env } from "./types";

export const COSE_ES256 = -7;
export const COSE_RS256 = -257;
/** What the browser is asked to offer, most preferred first. */
export const PASSKEY_ALGORITHMS = [COSE_ES256, COSE_RS256];

const FLAG_USER_PRESENT = 0x01;
const FLAG_ATTESTED_CREDENTIAL = 0x40;
const FLAG_EXTENSIONS = 0x80;
const MAX_ENCODED_LENGTH = 16 * 1024;

/** A ceremony the browser sent that does not check out. Its message is safe to show. */
export class PasskeyError extends Error {}

// ------------------------------------------------------------- base64url

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: unknown, what: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_ENCODED_LENGTH) {
    throw new PasskeyError(`The passkey's ${what} is missing or malformed.`);
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    throw new PasskeyError(`The passkey's ${what} is malformed.`);
  }
}

// ------------------------------------------------------------- CBOR

export type CborValue = number | string | boolean | null | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

/**
 * One CBOR item (RFC 8949) from the start of `bytes`, and how many bytes it took. Only what
 * WebAuthn uses: integers, byte and text strings, arrays, maps, false/true/null, all with
 * definite lengths. Anything else is refused rather than guessed at.
 */
export function decodeCbor(bytes: Uint8Array): { value: CborValue; length: number } {
  const [value, end] = decodeItem(bytes, 0, 0);
  return { value, length: end };
}

function decodeItem(bytes: Uint8Array, start: number, depth: number): [CborValue, number] {
  if (depth > 16) throw new PasskeyError("The passkey's data nests too deeply.");
  const need = (pos: number, count: number) => {
    if (pos + count > bytes.length) throw new PasskeyError("The passkey's data ends early.");
  };
  need(start, 1);
  const major = bytes[start] >> 5;
  const info = bytes[start] & 31;
  let pos = start + 1;
  let arg: number;
  if (info < 24) {
    arg = info;
  } else if (info === 24) {
    need(pos, 1);
    arg = bytes[pos];
    pos += 1;
  } else if (info === 25) {
    need(pos, 2);
    arg = bytes[pos] * 0x100 + bytes[pos + 1];
    pos += 2;
  } else if (info === 26) {
    need(pos, 4);
    arg = bytes[pos] * 0x1000000 + bytes[pos + 1] * 0x10000 + bytes[pos + 2] * 0x100 + bytes[pos + 3];
    pos += 4;
  } else if (info === 27) {
    need(pos, 8);
    const high = bytes[pos] * 0x1000000 + bytes[pos + 1] * 0x10000 + bytes[pos + 2] * 0x100 + bytes[pos + 3];
    if (high >= 0x200000) throw new PasskeyError("The passkey's data holds a number too large to read.");
    arg = high * 0x100000000 + bytes[pos + 4] * 0x1000000 + bytes[pos + 5] * 0x10000 + bytes[pos + 6] * 0x100 + bytes[pos + 7];
    pos += 8;
  } else {
    throw new PasskeyError("The passkey's data uses an encoding this server does not accept.");
  }

  switch (major) {
    case 0:
      return [arg, pos];
    case 1:
      return [-1 - arg, pos];
    case 2:
      need(pos, arg);
      return [bytes.slice(pos, pos + arg), pos + arg];
    case 3: {
      need(pos, arg);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(pos, pos + arg));
      } catch {
        throw new PasskeyError("The passkey's data holds text that is not UTF-8.");
      }
      return [text, pos + arg];
    }
    case 4: {
      // Every item takes at least one byte, so a count beyond what is left is malformed.
      need(pos, arg);
      const items: CborValue[] = [];
      for (let i = 0; i < arg; i++) {
        const [item, next] = decodeItem(bytes, pos, depth + 1);
        items.push(item);
        pos = next;
      }
      return [items, pos];
    }
    case 5: {
      need(pos, arg * 2);
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < arg; i++) {
        const [key, afterKey] = decodeItem(bytes, pos, depth + 1);
        if (typeof key !== "number" && typeof key !== "string") throw new PasskeyError("The passkey's data has a map key this server does not accept.");
        if (map.has(key)) throw new PasskeyError("The passkey's data repeats a map key.");
        const [value, afterValue] = decodeItem(bytes, afterKey, depth + 1);
        map.set(key, value);
        pos = afterValue;
      }
      return [map, pos];
    }
    case 7:
      if (info === 20) return [false, pos];
      if (info === 21) return [true, pos];
      if (info === 22) return [null, pos];
      throw new PasskeyError("The passkey's data holds a value this server does not accept.");
    default:
      throw new PasskeyError("The passkey's data uses a tag this server does not accept.");
  }
}

// ------------------------------------------------------ authenticator data

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  /** Present at registration: the new credential's id and COSE public key. */
  credential?: { id: Uint8Array; publicKey: Map<CborValue, CborValue> };
}

export function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
  if (data.length < 37) throw new PasskeyError("The passkey's authenticator data is too short.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = data[32];
  const parsed: AuthenticatorData = { rpIdHash: data.slice(0, 32), flags, signCount: view.getUint32(33) };
  let pos = 37;
  if (flags & FLAG_ATTESTED_CREDENTIAL) {
    if (data.length < 55) throw new PasskeyError("The passkey's credential data is too short.");
    const idLength = view.getUint16(53);
    pos = 55;
    if (idLength < 16 || idLength > 1023 || pos + idLength > data.length) throw new PasskeyError("The passkey's credential id is malformed.");
    const id = data.slice(pos, pos + idLength);
    pos += idLength;
    const key = decodeCbor(data.subarray(pos));
    if (!(key.value instanceof Map)) throw new PasskeyError("The passkey's public key is malformed.");
    parsed.credential = { id, publicKey: key.value };
    pos += key.length;
  }
  if (flags & FLAG_EXTENSIONS) {
    const extensions = decodeCbor(data.subarray(pos));
    if (!(extensions.value instanceof Map)) throw new PasskeyError("The passkey's extensions are malformed.");
    pos += extensions.length;
  }
  if (pos !== data.length) throw new PasskeyError("The passkey's authenticator data has bytes left over.");
  return parsed;
}

// ------------------------------------------------------------- keys

export interface StoredPasskeyKey {
  alg: number;
  jwk: JsonWebKey;
}

function bytesOf(map: Map<CborValue, CborValue>, label: number): Uint8Array {
  const value = map.get(label);
  if (!(value instanceof Uint8Array)) throw new PasskeyError("The passkey's public key is incomplete.");
  return value;
}

/** A COSE public key (RFC 9053) as the JWK `crypto.subtle` imports. */
export function coseToJwk(key: Map<CborValue, CborValue>): StoredPasskeyKey {
  const kty = key.get(1);
  const alg = key.get(3);
  if (alg === COSE_ES256) {
    const x = bytesOf(key, -2);
    const y = bytesOf(key, -3);
    if (kty !== 2 || key.get(-1) !== 1 || x.length !== 32 || y.length !== 32) {
      throw new PasskeyError("The passkey's ES256 key is not a P-256 key.");
    }
    return { alg, jwk: { kty: "EC", crv: "P-256", x: toBase64url(x), y: toBase64url(y) } };
  }
  if (alg === COSE_RS256) {
    const n = bytesOf(key, -1);
    const e = bytesOf(key, -2);
    if (kty !== 3 || n.length < 256 || n.length > 512 || e.length === 0 || e.length > 4) {
      throw new PasskeyError("The passkey's RS256 key is not a 2048-bit or larger RSA key.");
    }
    return { alg, jwk: { kty: "RSA", n: toBase64url(n), e: toBase64url(e), alg: "RS256" } };
  }
  throw new PasskeyError("This passkey uses an algorithm this server does not accept (ES256 or RS256 only).");
}

async function importPasskeyKey(key: StoredPasskeyKey): Promise<CryptoKey> {
  const algorithm =
    key.alg === COSE_ES256 ? { name: "ECDSA", namedCurve: "P-256" } : key.alg === COSE_RS256 ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : null;
  if (!algorithm) throw new PasskeyError("This passkey uses an algorithm this server does not accept.");
  try {
    return await crypto.subtle.importKey("jwk", key.jwk, algorithm, false, ["verify"]);
  } catch {
    throw new PasskeyError("The passkey's public key could not be read.");
  }
}

/** An ASN.1 DER ECDSA signature (what WebAuthn sends) as the raw r||s `crypto.subtle` verifies. */
export function derToRawEcdsa(der: Uint8Array, size = 32): Uint8Array {
  const bad = () => new PasskeyError("The passkey's signature is malformed.");
  let pos = 0;
  if (der[pos++] !== 0x30) throw bad();
  let length = der[pos++];
  if (length === 0x81) length = der[pos++];
  else if (length & 0x80) throw bad();
  if (pos + length !== der.length) throw bad();
  const raw = new Uint8Array(size * 2);
  for (const offset of [0, size]) {
    if (der[pos++] !== 0x02) throw bad();
    const n = der[pos++];
    if (!n || n > size + 1 || pos + n > der.length) throw bad();
    let int = der.subarray(pos, pos + n);
    pos += n;
    while (int.length > 1 && int[0] === 0) int = int.subarray(1);
    if (int.length > size) throw bad();
    raw.set(int, offset + size - int.length);
  }
  if (pos !== der.length) throw bad();
  return raw;
}

// ------------------------------------------------------------- ceremonies

export interface RelyingParty {
  rpId: string;
  /** The exact origin the browser must report: this request's scheme and host. */
  origin: string;
}

/** The relying party for a request: the platform domain on hosts under it, otherwise the host. */
export function passkeyRelyingParty(env: Pick<Env, "DEFAULT_DOMAIN">, request: Request): RelyingParty {
  const url = new URL(request.url);
  const host = (request.headers.get("host") || url.host).toLowerCase();
  const hostname = host.replace(/:\d+$/, "");
  const base = (env.DEFAULT_DOMAIN || "").replace(/^\./, "").toLowerCase();
  const rpId = base && (hostname === base || hostname.endsWith("." + base)) ? base : hostname;
  return { rpId, origin: `${url.protocol}//${host}` };
}

/** A fresh ceremony challenge: 32 random bytes, base64url, as the browser echoes it back. */
export function newPasskeyChallenge(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

function checkClientData(clientDataJSON: Uint8Array, type: string, challenge: string, origin: string): void {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(clientDataJSON));
  } catch {
    throw new PasskeyError("The passkey's client data is not JSON.");
  }
  if (!data || typeof data !== "object") throw new PasskeyError("The passkey's client data is not JSON.");
  if (data.type !== type) throw new PasskeyError("The passkey answered a different kind of request.");
  if (data.challenge !== challenge) throw new PasskeyError("The passkey answered an older request. Try again.");
  if (data.origin !== origin) throw new PasskeyError("The passkey was used on a different site.");
  if (data.crossOrigin === true) throw new PasskeyError("The passkey was used from inside another site.");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function checkAuthenticatorData(data: AuthenticatorData, rpId: string): Promise<void> {
  if (!equalBytes(data.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) {
    throw new PasskeyError("The passkey belongs to a different site.");
  }
  if (!(data.flags & FLAG_USER_PRESENT)) throw new PasskeyError("The passkey did not confirm someone was present.");
}

export interface RegisteredPasskey extends StoredPasskeyKey {
  credentialId: string;
  signCount: number;
}

/** navigator.credentials.create()'s answer: the new credential, or a PasskeyError. */
export async function verifyPasskeyRegistration(
  response: { clientDataJSON?: unknown; attestationObject?: unknown },
  expected: RelyingParty & { challenge: string }
): Promise<RegisteredPasskey> {
  checkClientData(fromBase64url(response.clientDataJSON, "client data"), "webauthn.create", expected.challenge, expected.origin);
  const attestation = decodeCbor(fromBase64url(response.attestationObject, "attestation"));
  const authData = attestation.value instanceof Map ? attestation.value.get("authData") : null;
  if (!(authData instanceof Uint8Array)) throw new PasskeyError("The passkey's attestation is malformed.");
  const data = parseAuthenticatorData(authData);
  await checkAuthenticatorData(data, expected.rpId);
  if (!data.credential) throw new PasskeyError("The passkey did not include its public key.");
  const key = coseToJwk(data.credential.publicKey);
  await importPasskeyKey(key);
  return { ...key, credentialId: toBase64url(data.credential.id), signCount: data.signCount };
}

/** navigator.credentials.get()'s answer, against the stored key: the new counter, or a PasskeyError. */
export async function verifyPasskeyAssertion(
  response: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown },
  expected: RelyingParty & { challenge: string },
  stored: StoredPasskeyKey & { signCount: number }
): Promise<{ signCount: number }> {
  const clientDataJSON = fromBase64url(response.clientDataJSON, "client data");
  checkClientData(clientDataJSON, "webauthn.get", expected.challenge, expected.origin);
  const authData = fromBase64url(response.authenticatorData, "authenticator data");
  const data = parseAuthenticatorData(authData);
  await checkAuthenticatorData(data, expected.rpId);

  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(await sha256(clientDataJSON), authData.length);
  const signature = fromBase64url(response.signature, "signature");
  const key = await importPasskeyKey(stored);
  const ok =
    stored.alg === COSE_ES256
      ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRawEcdsa(signature), signed)
      : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signed);
  if (!ok) throw new PasskeyError("The passkey's signature does not match.");

  // Authenticators that count (most security keys) must move forward; synced passkeys send 0.
  if ((stored.signCount > 0 || data.signCount > 0) && data.signCount <= stored.signCount) {
    throw new PasskeyError("This passkey's counter went backwards, so it may have been copied. Use another way to sign in.");
  }
  return { signCount: data.signCount };
}
