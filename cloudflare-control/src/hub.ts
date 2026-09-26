/**
 * How the Worker reaches an organization's OrgHub (src/org_hub.ts).
 *
 * Every call names the organization, and the stub is looked up by that
 * organization's id, so one organization's request can never reach another's hub;
 * the hub itself also refuses a request naming a different organization than the
 * one it was created for.
 */

import { Env } from "./types";
import { isLocalEnvironment } from "./database";
import { LocalHubNamespace } from "./local_do";
import { DeviceMeta, ConsoleMeta } from "./org_hub";

let localHubs: LocalHubNamespace | null = null;

/** The namespace of organization hubs: the binding, or the in-process stand-in for tests and Node development. */
export function hubNamespace(env: Env): DurableObjectNamespace {
  if (env.ORG_HUB) return env.ORG_HUB;
  if (isLocalEnvironment(env)) return localHubNamespace(env) as unknown as DurableObjectNamespace;
  throw new Error("No ORG_HUB Durable Object binding. Declare it in wrangler.jsonc (see cloudflare-control/AGENTS.md, Rule 2d).");
}

/** The in-process stand-in, for tests that connect sockets or run alarms directly. */
export function localHubNamespace(env: Env): LocalHubNamespace {
  if (!localHubs) localHubs = new LocalHubNamespace(env);
  return localHubs;
}

function hubStub(env: Env, tenantId: string): DurableObjectStub {
  const namespace = hubNamespace(env);
  return namespace.get(namespace.idFromName(tenantId));
}

export async function hubRequest(
  env: Env,
  tenantId: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers = new Headers({ "x-labkiosk-tenant": tenantId });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return hubStub(env, tenantId).fetch(
    new Request(`https://org-hub${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  );
}

/** Call a hub and decode its JSON answer; a failure is an error the caller handles. */
export async function hubJson<T>(env: Env, tenantId: string, path: string, body?: unknown): Promise<T> {
  const res = await hubRequest(env, tenantId, path, body);
  if (!res.ok) throw new Error(`OrgHub ${path} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Tell an organization's hub that something its workstations see has changed.
 *
 * The change itself is already saved in D1. If the hub cannot be reached now,
 * workstations still pick it up when the hub's five-minute configuration cache
 * expires, so the administrator's request is not failed over it -- but the
 * failure is logged, never swallowed.
 */
export async function notifyConfigChanged(env: Env, tenantId: string): Promise<void> {
  try {
    await hubJson(env, tenantId, "/config-changed", {});
  } catch (err) {
    console.error(`[Worker] Could not tell organization ${tenantId}'s hub about a configuration change:`, err);
  }
}

/** Hand a WebSocket upgrade to the organization's hub, with an identity only the Worker can set. */
export function hubUpgrade(
  env: Env,
  tenantId: string,
  kind: "device" | "console",
  meta: Omit<DeviceMeta, "tenantId"> | Omit<ConsoleMeta, "tenantId">
): Promise<Response> {
  // A fresh request: no header the caller sent reaches the hub.
  return hubStub(env, tenantId).fetch(
    new Request(`https://org-hub/${kind}-ws`, {
      headers: {
        Upgrade: "websocket",
        "x-labkiosk-tenant": tenantId,
        "x-labkiosk-meta": JSON.stringify(meta)
      }
    })
  );
}

/**
 * Bindings and secrets production cannot run without, or null when all are set.
 *
 * The Worker fails closed (Rule 7): a deployment missing any of these would
 * silently lose live control, audit history or custom domains.
 */
export function requiredBindingsProblem(env: Env): string | null {
  const missing: string[] = [];
  if (!env.ORG_HUB) missing.push("ORG_HUB (Durable Object)");
  if (!env.AUDIT_QUEUE) missing.push("AUDIT_QUEUE (Queue producer)");
  if (!env.AUDIT_ARCHIVE) missing.push("AUDIT_ARCHIVE (R2 bucket)");
  if (!env.FLEET_METRICS) missing.push("FLEET_METRICS (Analytics Engine dataset)");
  if (!env.AUTH_RATE_LIMITER) missing.push("AUTH_RATE_LIMITER (rate limiting)");
  if (!env.CUSTOM_HOSTNAMES) missing.push("CUSTOM_HOSTNAMES (Workflow)");
  if (!env.CF_API_TOKEN) missing.push("CF_API_TOKEN (secret)");
  if (!env.CF_ZONE_ID) missing.push("CF_ZONE_ID (secret)");
  return missing.length
    ? `The worker is missing required bindings: ${missing.join(", ")}. See docs/DEPLOYMENT.md, "Platform resources".`
    : null;
}
