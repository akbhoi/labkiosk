/**
 * Custom domains through Cloudflare for SaaS.
 *
 * When a super admin approves an organization's own domain, a Cloudflare for
 * SaaS custom hostname is created in the platform's zone so Cloudflare issues
 * the domain's certificate and routes it to this Worker. Removing the domain
 * deletes the custom hostname again. Certificate issuance takes minutes, so the
 * work runs as a Workflow (`CustomHostnameWorkflow` in custom_hostname_workflow.ts)
 * with retried, durable steps; the organization's `custom_hostname_status` shows
 * where it is.
 *
 * The steps are written against a small `JobStep` interface so tests run the
 * same code inline with a mocked Cloudflare API.
 */

import { CustomHostnameParams, CustomHostnameStatus, Env } from "./types";
import { getDatabase, isLocalEnvironment } from "./database";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** How many times the certificate status is checked before the job stops waiting. */
const STATUS_CHECKS = 30;
/** Between checks: Cloudflare's own guidance is minutes, not seconds. */
const STATUS_CHECK_INTERVAL = "2 minutes";

/** The part of a Workflow step the job uses. */
export interface JobStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

interface CustomHostnameResult {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status?: string };
}

async function cloudflareApi<T>(env: Env, method: string, path: string, body?: unknown): Promise<{ status: number; data: CloudflareEnvelope<T> }> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    throw new Error("CF_API_TOKEN and CF_ZONE_ID must be set to manage custom hostnames");
  }
  const res = await fetch(`${CLOUDFLARE_API}/zones/${encodeURIComponent(env.CF_ZONE_ID)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = (await res.json()) as CloudflareEnvelope<T>;
  return { status: res.status, data };
}

function apiError(label: string, status: number, data: CloudflareEnvelope<unknown>): Error {
  const detail = (data.errors || []).map((e) => `${e.code} ${e.message}`).join("; ") || "no detail";
  return new Error(`${label} failed (HTTP ${status}): ${detail}`);
}

async function recordStatus(env: Env, tenantId: string, hostname: string, fields: { id?: string | null; status: CustomHostnameStatus }): Promise<void> {
  const db = getDatabase(env);
  // Only while the organization still has this domain: a later change wins.
  if (fields.id !== undefined) {
    await db
      .prepare("UPDATE tenants SET custom_hostname_id = ?, custom_hostname_status = ?, updated_at = ? WHERE id = ? AND custom_domain = ?")
      .bind(fields.id, fields.status, Math.floor(Date.now() / 1000), tenantId, hostname)
      .run();
  } else {
    await db
      .prepare("UPDATE tenants SET custom_hostname_status = ?, updated_at = ? WHERE id = ? AND custom_domain = ?")
      .bind(fields.status, Math.floor(Date.now() / 1000), tenantId, hostname)
      .run();
  }
}

/** Create a custom hostname and wait for its certificate; or delete one. */
export async function runCustomHostnameJob(env: Env, params: CustomHostnameParams, step: JobStep): Promise<CustomHostnameStatus> {
  if (params.operation === "delete") {
    if (!params.customHostnameId) return "none";
    await step.do("delete custom hostname", async () => {
      const { status, data } = await cloudflareApi(env, "DELETE", `/custom_hostnames/${encodeURIComponent(params.customHostnameId!)}`);
      // Already gone is the outcome we wanted.
      if (!data.success && status !== 404) throw apiError("Deleting the custom hostname", status, data);
      return true;
    });
    return "none";
  }

  const id = await step.do("create custom hostname", async () => {
    const created = await cloudflareApi<CustomHostnameResult>(env, "POST", "/custom_hostnames", {
      hostname: params.hostname,
      ssl: { method: "http", type: "dv" }
    });
    if (created.data.success) return created.data.result.id;
    // A retry after a created-but-unrecorded attempt finds it already there.
    const existing = await cloudflareApi<CustomHostnameResult[]>(
      env,
      "GET",
      `/custom_hostnames?hostname=${encodeURIComponent(params.hostname)}`
    );
    const match = existing.data.success ? existing.data.result.find((h) => h.hostname === params.hostname) : undefined;
    if (match) return match.id;
    throw apiError("Creating the custom hostname", created.status, created.data);
  });

  await step.do("record custom hostname", async () => {
    await recordStatus(env, params.tenantId, params.hostname, { id, status: "pending" });
    return true;
  });

  for (let check = 1; check <= STATUS_CHECKS; check++) {
    const state = await step.do(`check certificate ${check}`, async () => {
      const { status, data } = await cloudflareApi<CustomHostnameResult>(env, "GET", `/custom_hostnames/${encodeURIComponent(id)}`);
      if (!data.success) throw apiError("Reading the custom hostname", status, data);
      return { hostname: data.result.status, ssl: data.result.ssl?.status || "" };
    });
    if (state.hostname === "active" && state.ssl === "active") {
      await step.do("record active", async () => {
        await recordStatus(env, params.tenantId, params.hostname, { status: "active" });
        return true;
      });
      return "active";
    }
    if (["blocked", "moved", "deleted"].includes(state.hostname) || state.ssl.endsWith("_timed_out")) {
      await step.do("record failure", async () => {
        await recordStatus(env, params.tenantId, params.hostname, { status: "failed" });
        return true;
      });
      return "failed";
    }
    await step.sleep(`wait for certificate ${check}`, STATUS_CHECK_INTERVAL);
  }
  // Still pending after the checks: the status stays "pending" for the super admin to see.
  return "pending";
}

/**
 * Start a custom hostname job.
 *
 * Production runs it as a Workflow. Tests and local development have no
 * Cloudflare for SaaS zone to call, so the organization is marked `local` and
 * nothing leaves the machine.
 */
export async function startCustomHostnameJob(env: Env, params: CustomHostnameParams): Promise<void> {
  if (env.CUSTOM_HOSTNAMES) {
    await env.CUSTOM_HOSTNAMES.create({ params });
    return;
  }
  if (!isLocalEnvironment(env)) {
    throw new Error("No CUSTOM_HOSTNAMES workflow binding; custom domains cannot be provisioned");
  }
  if (params.operation === "create") {
    await recordStatus(env, params.tenantId, params.hostname, { id: null, status: "local" });
  }
  console.log(`[Worker] Local development: custom hostname ${params.operation} for ${params.hostname} not sent to Cloudflare.`);
}
