/**
 * The Razorpay relay: the one place outside Cloudflare that the control plane
 * calls Razorpay's API through.
 *
 * Why it exists: api.razorpay.com sits on an AWS load balancer that refuses the
 * TLS handshake from Cloudflare Workers, which surfaces as HTTP 525. This relay
 * runs on Google Cloud (Cloud Run functions, asia-south1) and forwards the
 * calls in ALLOWED (payment links and subscriptions) to Razorpay unchanged.
 *
 * What it trusts: only requests signed with RELAY_SECRET, which the Worker
 * holds as RAZORPAY_RELAY_SECRET. The signature is the hex HMAC-SHA256 of
 * "<timestamp>\n<method>\n<path>\n<body>" and the timestamp must be within five
 * minutes. It keeps no state and holds no Razorpay keys: the Worker sends its
 * own Basic authorization, which is passed through to Razorpay as it is.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const RAZORPAY_ORIGIN = "https://api.razorpay.com";
/**
 * The only calls the relay forwards. A path is matched whole, query included:
 * ids are Razorpay's own shape, and the only query is a subscription's invoices.
 */
export const ALLOWED = Object.freeze([
  { method: "POST", path: /^\/v1\/payment_links$/ },
  { method: "POST", path: /^\/v1\/plans$/ },
  { method: "POST", path: /^\/v1\/subscriptions$/ },
  { method: "GET", path: /^\/v1\/subscriptions\/sub_[A-Za-z0-9]{1,32}$/ },
  { method: "POST", path: /^\/v1\/subscriptions\/sub_[A-Za-z0-9]{1,32}\/cancel$/ },
  { method: "GET", path: /^\/v1\/payments\/pay_[A-Za-z0-9]{1,32}$/ },
  { method: "GET", path: /^\/v1\/invoices\?subscription_id=sub_[A-Za-z0-9]{1,32}&count=100&skip=\d{1,6}$/ }
]);
export const MAX_SKEW_SECONDS = 300;
const MAX_BODY_BYTES = 64 * 1024;

export function relaySignature(secret, timestamp, method, path, body) {
  return createHmac("sha256", secret).update(`${timestamp}\n${method}\n${path}\n${body}`).digest("hex");
}

function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !/^[0-9a-f]+$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function refuse(status, error) {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { description: error } }) };
}

/**
 * Handle one request. `headers` keys are lower case. Returns the response to
 * send: Razorpay's own status, content type and body when it was forwarded.
 * @param {{ method: string, path: string, headers: Record<string, string | undefined>, body: string, secret: string | undefined, nowSeconds: number, fetchImpl: typeof fetch }} input
 */
export async function handleRelay(input) {
  // A secret stored from a file often ends in a newline; the Worker's copy does not.
  const secret = typeof input.secret === "string" ? input.secret.trim() : "";
  if (secret.length < 32) {
    console.error("[relay] RELAY_SECRET is not set, or is shorter than 32 characters");
    return refuse(503, "The relay is not configured");
  }
  const method = String(input.method || "").toUpperCase();
  const path = String(input.path || "");
  if (!ALLOWED.some((a) => a.method === method && a.path.test(path))) return refuse(404, "Not a call this relay forwards");
  const body = typeof input.body === "string" ? input.body : "";
  if (method === "GET" && body) return refuse(400, "A GET carries no body");
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return refuse(413, "The request body is too large");

  const timestamp = input.headers["x-relay-timestamp"] || "";
  const signature = (input.headers["x-relay-signature"] || "").toLowerCase();
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(input.nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return refuse(401, "The request is not signed, or its time is more than five minutes off");
  }
  if (!sameHex(relaySignature(secret, timestamp, method, path, body), signature)) return refuse(401, "The signature does not match");

  const authorization = input.headers.authorization || "";
  if (!/^Basic [A-Za-z0-9+/=]+$/.test(authorization)) return refuse(400, "Razorpay authorization is missing");

  let res;
  try {
    res = await input.fetchImpl(`${RAZORPAY_ORIGIN}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json", accept: "application/json" },
      body: method === "GET" ? undefined : body
    });
  } catch (err) {
    console.error("[relay] Razorpay could not be reached:", err);
    return refuse(502, "Razorpay could not be reached from the relay");
  }
  return {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") || "application/json" },
    body: await res.text()
  };
}
