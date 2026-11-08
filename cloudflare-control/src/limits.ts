/**
 * What a plan allows besides workstations: staff accounts and Remote Control
 * seats (src/plans.ts entitlement). Workstations are src/plan_sync.ts.
 *
 * Staff: the owner never counts. Staff beyond the plan's cap after a
 * downgrade or a lapse are suspended, the most recently added first: they
 * keep their account and permissions but cannot use the console, and their
 * sessions end. An admin may swap who is suspended, within the cap.
 *
 * Remote Control: each seat belongs to one workstation
 * (remote_control_workstations). A workstation takes a free seat the first
 * time an operator opens it; the admin may move seats under Plan & billing.
 * Seats beyond the plan's count are released, the most recently assigned
 * first.
 */

import type { Tenant } from "./types";

export interface StaffMember {
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: number;
  suspendedAt: number | null;
}

export async function listStaff(db: D1Database, tenant: Pick<Tenant, "id" | "user_id">): Promise<StaffMember[]> {
  const { results } = await db
    .prepare(
      `SELECT tu.user_id AS user_id, u.name AS name, u.email AS email, tu.role AS role, tu.created_at AS created_at, tu.suspended_at AS suspended_at
         FROM tenant_users tu JOIN users u ON u.id = tu.user_id
        WHERE tu.tenant_id = ? AND tu.user_id != ?
        ORDER BY tu.created_at ASC, tu.id ASC`
    )
    .bind(tenant.id, tenant.user_id)
    .all<{ user_id: string; name: string; email: string; role: string; created_at: number; suspended_at: number | null }>();
  return (results ?? []).map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    createdAt: Number(r.created_at),
    suspendedAt: r.suspended_at === null ? null : Number(r.suspended_at)
  }));
}

export async function activeStaffCount(db: D1Database, tenant: Pick<Tenant, "id" | "user_id">): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM tenant_users WHERE tenant_id = ? AND user_id != ? AND suspended_at IS NULL")
    .bind(tenant.id, tenant.user_id)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Why another staff member cannot be added or restored, or null when one can. */
export async function staffCapRefusal(db: D1Database, tenant: Pick<Tenant, "id" | "user_id">, limit: number): Promise<string | null> {
  const active = await activeStaffCount(db, tenant);
  if (active < limit) return null;
  return `The plan allows ${limit} staff account${limit === 1 ? "" : "s"} besides the owner, and all are in use. Upgrade under Plan & billing, or suspend someone first.`;
}

async function endSessions(db: D1Database, tenantId: string, userIds: string[]): Promise<void> {
  for (let i = 0; i < userIds.length; i += 90) {
    const chunk = userIds.slice(i, i + 90);
    await db
      .prepare(`DELETE FROM sessions WHERE tenant_id = ? AND user_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(tenantId, ...chunk)
      .run();
  }
}

/** Suspend the most recently added staff beyond the cap. Returns who was suspended. */
export async function enforceStaffCap(db: D1Database, tenant: Pick<Tenant, "id" | "user_id">, limit: number, now: number): Promise<string[]> {
  const active = (await listStaff(db, tenant)).filter((s) => s.suspendedAt === null);
  if (active.length <= limit) return [];
  const over = active.slice(limit).map((s) => s.userId);
  for (let i = 0; i < over.length; i += 90) {
    const chunk = over.slice(i, i + 90);
    await db
      .prepare(`UPDATE tenant_users SET suspended_at = ? WHERE tenant_id = ? AND suspended_at IS NULL AND user_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(now, tenant.id, ...chunk)
      .run();
  }
  await endSessions(db, tenant.id, over);
  return over;
}

/** Suspend or restore one staff member; restoring needs room under the cap. */
export async function setStaffSuspended(
  db: D1Database,
  tenant: Pick<Tenant, "id" | "user_id">,
  userId: string,
  suspended: boolean,
  limit: number,
  now: number
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (userId === tenant.user_id) return { ok: false, error: "The owner cannot be suspended", status: 400 };
  const member = (await listStaff(db, tenant)).find((s) => s.userId === userId);
  if (!member) return { ok: false, error: "Staff member not found", status: 404 };
  if (suspended) {
    if (member.suspendedAt !== null) return { ok: true };
    await db.prepare("UPDATE tenant_users SET suspended_at = ? WHERE tenant_id = ? AND user_id = ?").bind(now, tenant.id, userId).run();
    await endSessions(db, tenant.id, [userId]);
    return { ok: true };
  }
  if (member.suspendedAt === null) return { ok: true };
  const refusal = await staffCapRefusal(db, tenant, limit);
  if (refusal) return { ok: false, error: refusal, status: 402 };
  await db.prepare("UPDATE tenant_users SET suspended_at = NULL WHERE tenant_id = ? AND user_id = ?").bind(tenant.id, userId).run();
  return { ok: true };
}

// ------------------------------------------------------------ Remote Control

export async function listRemoteSeats(db: D1Database, tenantId: string): Promise<Array<{ clientId: string; assignedAt: number }>> {
  const { results } = await db
    .prepare("SELECT client_id, assigned_at FROM remote_control_workstations WHERE tenant_id = ? ORDER BY assigned_at ASC, client_id ASC")
    .bind(tenantId)
    .all<{ client_id: string; assigned_at: number }>();
  return (results ?? []).map((r) => ({ clientId: r.client_id, assignedAt: Number(r.assigned_at) }));
}

/**
 * Whether Remote Control may open this workstation: it holds a seat, or a
 * seat is free and it takes it now.
 */
export async function claimRemoteSeat(
  db: D1Database,
  tenantId: string,
  clientId: string,
  seats: number,
  userId: string,
  now: number
): Promise<{ ok: true; claimed: boolean } | { ok: false; error: string }> {
  const held = await db
    .prepare("SELECT 1 AS held FROM remote_control_workstations WHERE tenant_id = ? AND client_id = ?")
    .bind(tenantId, clientId)
    .first<{ held: number }>();
  if (held) return { ok: true, claimed: false };
  if (seats <= 0) {
    return { ok: false, error: "Remote Control is an add-on: buy seats for the workstations you want to reach under Plan & billing." };
  }
  // Take a seat only while one is free, in one statement, so two operators cannot both take the last one.
  const taken = await db
    .prepare(
      `INSERT OR IGNORE INTO remote_control_workstations (tenant_id, client_id, assigned_at, assigned_by)
       SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM remote_control_workstations WHERE tenant_id = ?) < ?`
    )
    .bind(tenantId, clientId, now, userId, tenantId, seats)
    .run();
  if (taken.meta.changes) return { ok: true, claimed: true };
  return {
    ok: false,
    error: `All ${seats} Remote Control seat${seats === 1 ? " is" : "s are"} assigned to other workstations. Move a seat to this one, or buy more, under Plan & billing.`
  };
}

export async function assignRemoteSeat(
  db: D1Database,
  tenantId: string,
  clientId: string,
  assigned: boolean,
  seats: number,
  userId: string,
  now: number
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (!assigned) {
    await db.prepare("DELETE FROM remote_control_workstations WHERE tenant_id = ? AND client_id = ?").bind(tenantId, clientId).run();
    return { ok: true };
  }
  const enrolled = await db
    .prepare("SELECT 1 AS enrolled FROM device_tokens WHERE tenant_id = ? AND client_id = ? AND revoked = 0 LIMIT 1")
    .bind(tenantId, clientId)
    .first<{ enrolled: number }>();
  if (!enrolled) return { ok: false, error: "That workstation is not enrolled", status: 404 };
  const claim = await claimRemoteSeat(db, tenantId, clientId, seats, userId, now);
  return claim.ok ? { ok: true } : { ok: false, error: claim.error, status: 402 };
}

/** Release the most recently assigned seats beyond the plan's count, and any on removed workstations. Returns those released. */
export async function enforceRemoteSeats(db: D1Database, tenantId: string, seats: number): Promise<string[]> {
  await db
    .prepare(
      "DELETE FROM remote_control_workstations WHERE tenant_id = ? AND client_id NOT IN (SELECT client_id FROM device_tokens WHERE tenant_id = ? AND revoked = 0)"
    )
    .bind(tenantId, tenantId)
    .run();
  const held = await listRemoteSeats(db, tenantId);
  if (held.length <= seats) return [];
  const released = held.slice(Math.max(seats, 0)).map((s) => s.clientId);
  for (let i = 0; i < released.length; i += 90) {
    const chunk = released.slice(i, i + 90);
    await db
      .prepare(`DELETE FROM remote_control_workstations WHERE tenant_id = ? AND client_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(tenantId, ...chunk)
      .run();
  }
  return released;
}
