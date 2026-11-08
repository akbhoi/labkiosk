/**
 * Apply an organization's plan to its workstations after anything that can
 * change what it covers: a plan or limit set, a trial started, a payment, an
 * education approval, a workstation removed, the hourly check for plans that
 * ended. Kept apart from src/plans.ts, which OrgHub imports, because this
 * reaches the hub.
 */

import { findTenantById, setClientsBroadcast, updateTenant, writeAuditLog } from "./db";
import { notifyConfigChanged } from "./hub";
import { enforceRemoteSeats, enforceStaffCap } from "./limits";
import { createNotification } from "./notifications";
import { isDemoSlug } from "./demo";
import { entitlement, moveLicenceTo, rebalanceLicences, type Entitlement, type Rebalance } from "./plans";
import type { Env, Tenant } from "./types";

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
  await syncAddOns(db, tenant, plan, Math.floor(nowMs / 1000));
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

/**
 * Staff and Remote Control seats follow the plan too: staff over the cap are
 * suspended, seats over the count released, and seats bought turn Remote
 * Control on unless the platform turned it off.
 */
async function syncAddOns(db: D1Database, tenant: Tenant, plan: Entitlement, now: number): Promise<void> {
  if (isDemoSlug(tenant.subdomain)) return;
  const suspended = await enforceStaffCap(db, tenant, plan.staffLimit, now);
  if (suspended.length) {
    const n = suspended.length;
    await writeAuditLog(db, { tenantId: tenant.id, action: "staff.suspended_over_cap", details: `users=${suspended.join(",")} limit=${plan.staffLimit}` });
    await createNotification(db, {
      tenantId: tenant.id,
      kind: "license",
      title: "Staff over the plan's limit",
      body:
        `${tenant.name} is on the ${plan.label} plan, which allows ${plan.staffLimit} staff account${plan.staffLimit === 1 ? "" : "s"} besides the owner. ` +
        `${n} staff ${n === 1 ? "member added most recently is" : "members added most recently are"} suspended until the plan allows more. Choose who stays active under Plan & billing.`,
      createdBy: null
    });
  }
  const released = await enforceRemoteSeats(db, tenant.id, plan.remoteSeats);
  if (released.length) {
    await writeAuditLog(db, { tenantId: tenant.id, action: "remote_control.seats_released", details: `clients=${released.join(",")} seats=${plan.remoteSeats}` });
  }
  // How many sessions may be open at once is the platform's setting; a purchase raises it (src/subscriptions.ts).
  const update: Partial<Tenant> = {};
  if (plan.remoteSeats > 0 && tenant.remote_control_status !== "approved" && !tenant.remote_control_revoked_at) update.remote_control_status = "approved";
  if (Object.keys(update).length) await updateTenant(db, tenant.id, update);
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
