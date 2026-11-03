/**
 * Apply an organization's plan to its workstations after anything that can
 * change what it covers: a plan or limit set, a trial started, a payment, an
 * education approval, a workstation removed, the hourly check for plans that
 * ended. Kept apart from src/plans.ts, which OrgHub imports, because this
 * reaches the hub.
 */

import { findTenantById, setClientsBroadcast } from "./db";
import { notifyConfigChanged } from "./hub";
import { createNotification } from "./notifications";
import { entitlement, moveLicenceTo, rebalanceLicences, type Rebalance } from "./plans";
import type { Env } from "./types";

/**
 * A workstation that gets its licence back leaves the notice: a reset
 * broadcast newer than the notice's sends it to the portal (OrgHub.configFor).
 */
async function releaseNotice(db: D1Database, tenantId: string, clientIds: string[], nowMs: number): Promise<void> {
  await setClientsBroadcast(db, tenantId, clientIds, null, nowMs);
}

export async function syncLicences(env: Env, db: D1Database, tenantId: string, nowMs = Date.now()): Promise<Rebalance> {
  const tenant = await findTenantById(db, tenantId);
  if (!tenant) return { unlicensed: [], relicensed: [] };
  const plan = entitlement(tenant, Math.floor(nowMs / 1000));
  const result = await rebalanceLicences(db, tenantId, plan.limit, Math.floor(nowMs / 1000));
  if (!result.unlicensed.length && !result.relicensed.length) return result;
  await releaseNotice(db, tenantId, result.relicensed, nowMs);
  if (result.unlicensed.length) {
    const n = result.unlicensed.length;
    await createNotification(db, {
      tenantId,
      kind: "license",
      title: "Workstations over the plan's limit",
      body:
        `${tenant.name} is on the ${plan.label} plan, which covers ${plan.limit} workstation${plan.limit === 1 ? "" : "s"}. ` +
        `${n} ${n === 1 ? "workstation" : "workstations"} seen least recently now ${n === 1 ? "shows" : "show"} a licence notice instead of your portal. ` +
        "Choose which workstations keep their licence, or change the plan, under Plan.",
      createdBy: null
    });
  }
  await notifyConfigChanged(env, tenantId);
  return result;
}

/** Move a licence to a workstation that shows the notice (Plan page). */
export async function moveLicence(
  env: Env,
  db: D1Database,
  tenantId: string,
  clientId: string,
  nowMs = Date.now()
): Promise<{ ok: true; displaced: string | null } | { ok: false; error: string; status: number }> {
  const tenant = await findTenantById(db, tenantId);
  if (!tenant) return { ok: false, error: "Organization not found", status: 404 };
  const plan = entitlement(tenant, Math.floor(nowMs / 1000));
  const moved = await moveLicenceTo(db, tenantId, clientId, plan.limit, Math.floor(nowMs / 1000));
  if (!moved.ok) return moved;
  await releaseNotice(db, tenantId, [clientId], nowMs);
  await notifyConfigChanged(env, tenantId);
  return moved;
}
