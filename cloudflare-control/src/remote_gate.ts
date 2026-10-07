/**
 * The Remote Control gate, for workstations on the platform's remote-control
 * domain (`platform` mode in src/remote_tunnels.ts).
 *
 * Each such workstation's tunnel sits behind a Cloudflare Access application
 * that admits only the platform's service token. Operators never sign in to
 * Access -- a person signing in would take one of the platform account's Zero
 * Trust seats, and a service token takes none. Instead:
 *
 *   1. an operator signed in to the console, with the `workstations`
 *      permission, asks for a pass (POST /api/clients/remote-pass);
 *   2. the pass -- organization, workstation and expiry, signed with a key
 *      derived from REMOTE_TUNNEL_KEY -- is good for REMOTE_PASS_SECONDS;
 *   3. the console frames `https://vnc.<domain>/w/<pass>/vnc.html`. The pass
 *      rides in the path, so every noVNC asset and the WebSocket carry it
 *      without a third-party cookie;
 *   4. this module checks the pass and that the workstation still has an active
 *      tunnel, then forwards the request to `https://<its address>/...` with
 *      the service token's headers.
 *
 * A WebSocket opened while the pass is valid stays open; a new one needs a new
 * pass, which the console fetches each time Remote Control is opened.
 */

import { isHostUnder } from "./guard";
import { platformTunnelConfig, remoteGateHost, remoteTunnelKeyBytes } from "./remote_tunnels";
import { Env } from "./types";

export const REMOTE_PASS_SECONDS = 120;

const PASS_KEY_INFO = "labkiosk remote-control pass v1";
const GATE_PATH = /^\/w\/([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})(\/[^?#]*)$/;
/** Request headers noVNC needs; everything else, cookies included, stays behind. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "user-agent",
  "if-none-match",
  "if-modified-since",
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions"
];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "etag", "last-modified"];

interface RemotePassBody {
  /** organization id */
  t: string;
  /** workstation id */
  c: string;
  /** expiry, Unix seconds */
  e: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** An HMAC key of its own, so the sealing key is never used for signing too. */
async function passKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", remoteTunnelKeyBytes(env), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(PASS_KEY_INFO) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

export async function issueRemotePass(env: Env, tenantId: string, clientId: string, now: number): Promise<string> {
  const body: RemotePassBody = { t: tenantId, c: clientId, e: now + REMOTE_PASS_SECONDS };
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(body)));
  const signature = await crypto.subtle.sign("HMAC", await passKey(env), new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The organization and workstation a pass names, or null when it is forged, altered or expired. */
export async function verifyRemotePass(
  env: Env,
  payload: string,
  signature: string,
  now: number
): Promise<{ tenantId: string; clientId: string } | null> {
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", await passKey(env), fromBase64Url(signature), new TextEncoder().encode(payload));
  } catch (err) {
    console.error("[RemoteGate] Could not check a pass:", err);
    return null;
  }
  if (!valid) return null;
  let body: RemotePassBody;
  try {
    body = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as RemotePassBody;
  } catch (err) {
    console.error("[RemoteGate] A correctly signed pass did not parse:", err);
    return null;
  }
  if (typeof body.t !== "string" || typeof body.c !== "string" || typeof body.e !== "number" || body.e < now) return null;
  return { tenantId: body.t, clientId: body.c };
}

function gateError(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}

/** Where the gate's pages may be framed: the console, and the organization's approved own domain. */
function frameAncestors(env: Env, customDomain: string | null): string {
  const sources: string[] = [];
  if (env.DEFAULT_DOMAIN) sources.push(`https://${env.DEFAULT_DOMAIN}`, `https://*.${env.DEFAULT_DOMAIN}`);
  if (customDomain) sources.push(`https://${customDomain}`);
  return sources.length > 0 ? sources.join(" ") : "'none'";
}

/**
 * Answer a request to the gate's host, or null when the request is for any
 * other host (or this server offers no platform domain).
 */
export async function handleRemoteGate(request: Request, url: URL, host: string, env: Env, db: D1Database): Promise<Response | null> {
  const platform = platformTunnelConfig(env);
  if (!platform || host !== remoteGateHost(platform)) return null;

  if (request.method !== "GET" && request.method !== "HEAD") return gateError(405, "Method not allowed");
  const match = GATE_PATH.exec(url.pathname);
  if (!match) return gateError(404, "Not found");
  const now = Math.floor(Date.now() / 1000);
  const pass = await verifyRemotePass(env, match[1], match[2], now);
  if (!pass) return gateError(403, "This Remote Control link has expired. Open Remote Control again from the console.");

  const row = await db
    .prepare(
      `SELECT r.hostname, t.custom_domain, t.custom_domain_status
       FROM remote_tunnels r
       JOIN remote_tunnel_accounts a ON a.tenant_id = r.tenant_id
       JOIN tenants t ON t.id = r.tenant_id
       WHERE r.tenant_id = ? AND r.client_id = ? AND r.status = 'active' AND a.mode = 'platform' AND t.status = 'active'`
    )
    .bind(pass.tenantId, pass.clientId)
    .first<{ hostname: string; custom_domain: string | null; custom_domain_status: string }>();
  if (!row) return gateError(404, "This workstation has no Remote Control tunnel.");
  const workstationHost = row.hostname.toLowerCase();
  if (!isHostUnder(workstationHost, platform.domain) || workstationHost === platform.domain || workstationHost === host) {
    console.error(`[RemoteGate] Refusing to forward to ${workstationHost}: not a workstation address under ${platform.domain}`);
    return gateError(502, "This workstation's Remote Control address is not valid.");
  }

  const target = new URL(`https://${workstationHost}${match[3]}`);
  target.search = url.search;
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("CF-Access-Client-Id", platform.accessClientId);
  headers.set("CF-Access-Client-Secret", platform.accessClientSecret);

  if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
    const upstream = await fetch(target.toString(), { headers });
    if (upstream.status !== 101) {
      console.error(`[RemoteGate] ${workstationHost} answered a WebSocket with ${upstream.status}`);
      return gateError(502, "The workstation did not accept the Remote Control connection.");
    }
    return upstream;
  }

  const upstream = await fetch(target.toString(), { method: request.method, headers, redirect: "manual" });
  const refused = (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) || upstream.status === 401 || upstream.status === 403;
  if (refused) {
    // Access answers a request it did not admit with a redirect to its login
    // page or a 403: the service token or the application is wrong.
    console.error(`[RemoteGate] ${workstationHost} refused the gate with ${upstream.status}`);
    return gateError(502, "The workstation's tunnel refused the Remote Control gate.");
  }
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  const customDomain = row.custom_domain_status === "approved" ? row.custom_domain : null;
  responseHeaders.set("Content-Security-Policy", `frame-ancestors ${frameAncestors(env, customDomain)}`);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Referrer-Policy", "no-referrer");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
