/**
 * Console addresses: `<subdomain>.<platform domain>`.
 *
 * An organization's first address (`subdomain`) is the one it registered with,
 * or one generated from its name for organizations from before addresses were
 * chosen at signup. It changes its address itself from Settings, at most once a
 * week, with no approval: the new one is stored as `chosen_subdomain`, and with a
 * chosen address the root shows the public homepage. Nothing an organization
 * gave up stops reaching it: each workstation keeps the address it enrolled
 * with, so the first address stays and every chosen address it moved away from
 * is kept in `retired_addresses`, where nobody else can take it.
 */

import { findTenantBySubdomain } from "./db";
import { isReservedSlug } from "./guard";
import { Tenant } from "./types";

/** How long the organization-name part of a generated address may be. */
const NAME_PART_LENGTH = 20;
const SUFFIX_LENGTH = 4;
const SUFFIX_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const ATTEMPTS = 8;
/** How long a dismissed feature tip stays away. */
export const FEATURE_TIP_INTERVAL_SECONDS = 30 * 24 * 3600;

function nameSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_PART_LENGTH)
    .replace(/-+$/, "");
  return slug.length >= 2 ? slug : "org";
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH));
  return Array.from(bytes, (b) => SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length]).join("");
}

/** A free address for a new organization named `name`. */
export async function generateSubdomain(db: D1Database, name: string): Promise<string> {
  const base = nameSlug(name);
  for (let i = 0; i < ATTEMPTS; i++) {
    const candidate = `${base}-${randomSuffix()}`;
    if (!isReservedSlug(candidate) && !(await findTenantBySubdomain(db, candidate))) return candidate;
  }
  throw new Error(`No free address found for "${base}" after ${ATTEMPTS} attempts`);
}

/** The address an organization is shown and linked at: its chosen one when it has one. */
export function consoleSubdomain(tenant: Pick<Tenant, "subdomain" | "chosen_subdomain">): string {
  return tenant.chosen_subdomain || tenant.subdomain;
}

/** Whether the root of the organization's address shows its public homepage (else its User Portal). */
export function showsHomepage(tenant: Pick<Tenant, "address_generated" | "chosen_subdomain">): boolean {
  return !tenant.address_generated || Boolean(tenant.chosen_subdomain);
}

export type TipFeature = "remote_control" | "address";

/** What the console's feature tip should advertise now, if anything. */
export function featureTipFor(tenant: Tenant, nowSeconds: number): TipFeature[] {
  if (tenant.status !== "active") return [];
  if (tenant.feature_tip_dismissed_at && nowSeconds - tenant.feature_tip_dismissed_at < FEATURE_TIP_INTERVAL_SECONDS) return [];
  const features: TipFeature[] = [];
  const rc = tenant.remote_control_status || "none";
  if (rc === "none") features.push("remote_control");
  if (tenant.address_generated && !tenant.chosen_subdomain && !tenant.requested_subdomain) features.push("address");
  return features;
}

/** How often an organization may change its console address. */
export const ADDRESS_CHANGE_DAYS = 7;

/** When the organization may next change its address (Unix seconds), or null when it may now. */
export function nextAddressChangeAt(tenant: Pick<Tenant, "address_changed_at">, nowSeconds: number): number | null {
  if (!tenant.address_changed_at) return null;
  const next = Number(tenant.address_changed_at) + ADDRESS_CHANGE_DAYS * 24 * 3600;
  return next > nowSeconds ? next : null;
}

/**
 * Move the organization to `address`, already checked as free and allowed. The
 * address it leaves is retired (it keeps reaching the organization); moving back
 * to an address it retired, or to its first one, takes that one up again.
 */
export async function changeConsoleAddress(
  db: D1Database,
  tenant: Pick<Tenant, "id" | "subdomain" | "chosen_subdomain">,
  address: string,
  nowSeconds: number
): Promise<void> {
  const leaving = tenant.chosen_subdomain || null;
  const chosen = address === tenant.subdomain ? null : address;
  const statements = [db.prepare("DELETE FROM retired_addresses WHERE subdomain = ? AND tenant_id = ?").bind(address, tenant.id)];
  if (leaving && leaving !== address) {
    statements.push(
      db.prepare("INSERT OR REPLACE INTO retired_addresses (subdomain, tenant_id, retired_at) VALUES (?, ?, ?)").bind(leaving, tenant.id, nowSeconds)
    );
  }
  statements.push(
    db
      .prepare("UPDATE tenants SET chosen_subdomain = ?, requested_subdomain = NULL, address_changed_at = ?, updated_at = ? WHERE id = ?")
      .bind(chosen, nowSeconds, nowSeconds, tenant.id)
  );
  await db.batch(statements);
}
