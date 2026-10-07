/**
 * Cloudflare Turnstile in front of the two public forms that make the
 * platform send or file mail for a stranger: the signup email code and the
 * contact form.
 *
 * Optional: it is on only when both TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY are set. Half a configuration is a mistake, and the
 * forms refuse rather than run unprotected (Rule 10). A token is checked with
 * Cloudflare's siteverify and works once.
 */

import { Env } from "./types";

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const SITEVERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

/** The public site key when Turnstile is on, else null. */
export function turnstileSiteKey(env: Env): string | null {
  const site = (env.TURNSTILE_SITE_KEY || "").trim();
  const secret = (env.TURNSTILE_SECRET_KEY || "").trim();
  return site && secret ? site : null;
}

/** Why Turnstile is misconfigured, or null when it is fully on or fully off. */
export function turnstileConfigProblem(env: Env): string | null {
  const site = Boolean((env.TURNSTILE_SITE_KEY || "").trim());
  const secret = Boolean((env.TURNSTILE_SECRET_KEY || "").trim());
  if (site === secret) return null;
  return `Turnstile is half configured: set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither (docs/DEPLOYMENT.md).`;
}

/**
 * Check the token a form sent. Returns null when the request may go on, or
 * the message to refuse it with. With Turnstile off it always goes on.
 */
export async function turnstileRefusal(env: Env, token: unknown, ip: string, action: string): Promise<{ message: string; status: number } | null> {
  const problem = turnstileConfigProblem(env);
  if (problem) {
    console.error("[Turnstile]", problem);
    return { message: "This form is temporarily unavailable. Please write to us by email.", status: 503 };
  }
  if (!turnstileSiteKey(env)) return null;
  const response = typeof token === "string" ? token.trim() : "";
  // Cloudflare's tokens are at most 2048 characters.
  if (!response || response.length > 2048) return { message: "Please complete the check above the button and try again.", status: 400 };

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY!.trim());
  form.append("response", response);
  form.append("remoteip", ip);
  let result: { success?: boolean; action?: string; "error-codes"?: string[] };
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) throw new Error(`siteverify answered ${res.status}`);
    result = await res.json();
  } catch (err) {
    console.error("[Turnstile] Verification failed:", err);
    return { message: "We could not check that you are human just now. Please try again in a moment.", status: 503 };
  }
  if (!result.success) {
    console.warn("[Turnstile] Refused:", (result["error-codes"] || []).join(", ") || "no reason given");
    return { message: "The check did not pass. Please try it again.", status: 400 };
  }
  if (result.action && result.action !== action) return { message: "The check did not pass. Please try it again.", status: 400 };
  return null;
}
