/**
 * Notifications the platform shows in organization consoles (migration 0038).
 *
 * A notification is for one organization, or for every organization (tenant_id
 * NULL). The platform writes one when it changes something about an
 * organization (approval, Remote Control, the workstation limit, the license,
 * content taken down, a major release granted), when a major release is retired,
 * and when a super admin writes one under System -> Notifications. Each member
 * of staff dismisses them for themselves; a console shows the ones its user
 * has not dismissed. Email is separate: whoever writes a notification decides
 * whether the owners are emailed as well (`emailOrganizations`).
 */

import { isDemoSlug } from "./demo";
import { sendMail, mailConfigProblem } from "./mail";
import type { Env } from "./types";

export type NotificationKind = "general" | "account" | "release" | "legal" | "license" | "content" | "remote_control";

export const NOTIFICATION_KINDS: readonly NotificationKind[] = ["general", "account", "release", "legal", "license", "content", "remote_control"];
export const NOTIFICATION_LIMITS = { title: 120, body: 2000 } as const;

export function isNotificationKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.includes(value as NotificationKind);
}

export interface NotificationRow {
  id: string;
  tenant_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  created_at: number;
}

export interface NewNotification {
  /** The organization it is for; null for every organization. */
  tenantId: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  createdBy: string | null;
  now?: number;
}

/** Write a notification. Returns its id. */
export async function createNotification(db: D1Database, n: NewNotification): Promise<string> {
  const title = n.title.trim().slice(0, NOTIFICATION_LIMITS.title);
  const body = n.body.trim().slice(0, NOTIFICATION_LIMITS.body);
  if (!title || !body) throw new Error("A notification needs a title and a message");
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO notifications (id, tenant_id, kind, title, body, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, n.tenantId, n.kind, title, body, n.now ?? Math.floor(Date.now() / 1000), n.createdBy)
    .run();
  return id;
}

/**
 * The notifications one user of an organization sees, newest first: the
 * organization's own and those for every organization written since it
 * registered, each with whether this user has dismissed it.
 */
export async function listNotificationsFor(
  db: D1Database,
  tenantId: string,
  userId: string,
  options: { unreadOnly?: boolean; limit?: number } = {}
): Promise<Array<NotificationRow & { read: boolean }>> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows =
    (
      await db
        .prepare(
          `SELECT n.id, n.tenant_id, n.kind, n.title, n.body, n.created_at, r.read_at
           FROM notifications n
           JOIN tenants t ON t.id = ?
           LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
           WHERE (n.tenant_id = t.id OR (n.tenant_id IS NULL AND n.created_at >= t.created_at))
             ${options.unreadOnly ? "AND r.read_at IS NULL" : ""}
           ORDER BY n.created_at DESC, n.id
           LIMIT ?`
        )
        .bind(tenantId, userId, limit)
        .all<NotificationRow & { read_at: number | null }>()
    ).results || [];
  return rows.map(({ read_at, ...row }) => ({ ...row, read: read_at !== null && read_at !== undefined }));
}

/**
 * Dismiss notifications for one user. Only ids the organization can see are
 * marked; returns how many were. `ids` null dismisses all of them.
 */
export async function markNotificationsRead(
  db: D1Database,
  tenantId: string,
  userId: string,
  ids: readonly string[] | null,
  now = Math.floor(Date.now() / 1000)
): Promise<number> {
  const visible = await listNotificationsFor(db, tenantId, userId, { unreadOnly: true, limit: 200 });
  const wanted = ids ? new Set(ids) : null;
  const marking = visible.filter((n) => !wanted || wanted.has(n.id));
  if (!marking.length) return 0;
  await db.batch(
    marking.map((n) =>
      db.prepare("INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)").bind(n.id, userId, now)
    )
  );
  return marking.length;
}

/** The notifications the platform has written, newest first, for System -> Notifications. */
export async function listSentNotifications(
  db: D1Database,
  limit = 100
): Promise<Array<NotificationRow & { tenant_name: string | null; reads: number }>> {
  return (
    (
      await db
        .prepare(
          `SELECT n.id, n.tenant_id, n.kind, n.title, n.body, n.created_at, t.name AS tenant_name,
                  (SELECT COUNT(*) FROM notification_reads r WHERE r.notification_id = n.id) AS reads
           FROM notifications n LEFT JOIN tenants t ON t.id = n.tenant_id
           ORDER BY n.created_at DESC, n.id LIMIT ?`
        )
        .bind(limit)
        .all<NotificationRow & { tenant_name: string | null; reads: number }>()
    ).results || []
  );
}

export interface OrganizationOwner {
  tenantId: string;
  name: string;
  email: string;
  ownerName: string;
}

/**
 * The owners of the active organizations a notification reaches: one
 * organization's, or every customer's (the platform's own demos aside).
 */
export async function activeOrganizationOwners(db: D1Database, tenantId: string | null): Promise<OrganizationOwner[]> {
  const rows =
    (
      await db
        .prepare(
          `SELECT t.id, t.name, t.subdomain, u.email, u.name AS owner_name, u.role
           FROM tenants t JOIN users u ON u.id = t.user_id
           WHERE t.status = 'active' ${tenantId ? "AND t.id = ?" : ""}
           ORDER BY t.name`
        )
        .bind(...(tenantId ? [tenantId] : []))
        .all<{ id: string; name: string; subdomain: string; email: string; owner_name: string; role: string }>()
    ).results || [];
  return rows
    .filter((r) => !(isDemoSlug(r.subdomain) && r.role === "super_admin"))
    .map((r) => ({ tenantId: r.id, name: r.name, email: r.email, ownerName: r.owner_name }));
}

export interface EmailOutcome {
  emailed: number;
  emailFailed: number;
  /** Why nothing was sent, when the server cannot send email. */
  emailProblem: string | null;
}

/** How many notification emails are sent at once. */
const EMAILS_AT_ONCE = 10;

/**
 * Email a notification to the owners it reaches. `text` builds each message's
 * body for one organization, between the greeting and the signature.
 */
export async function emailOrganizations(
  env: Env,
  owners: readonly OrganizationOwner[],
  subject: string,
  text: (owner: OrganizationOwner) => string
): Promise<EmailOutcome> {
  if (!owners.length) return { emailed: 0, emailFailed: 0, emailProblem: null };
  if (mailConfigProblem(env)) {
    return { emailed: 0, emailFailed: 0, emailProblem: "This server cannot send email, so no organization was emailed" };
  }
  let emailed = 0;
  let emailFailed = 0;
  // A few at a time: one by one, every customer's owner would outlast the request.
  for (let i = 0; i < owners.length; i += EMAILS_AT_ONCE) {
    const batch = owners.slice(i, i + EMAILS_AT_ONCE);
    const results = await Promise.allSettled(
      batch.map((owner) =>
        sendMail(env, {
          to: owner.email,
          toName: owner.ownerName,
          subject,
          text: `Hello ${owner.ownerName || ""},\n\n${text(owner)}\n\nLab Kiosk`,
          template: { name: "notice", title: subject }
        })
      )
    );
    results.forEach((result, j) => {
      if (result.status === "fulfilled") {
        emailed++;
      } else {
        emailFailed++;
        console.error(`[Worker] Could not email ${batch[j].name} (${subject}):`, result.reason);
      }
    });
  }
  return { emailed, emailFailed, emailProblem: null };
}
