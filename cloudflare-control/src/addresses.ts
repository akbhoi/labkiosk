/**
 * Console addresses: `<subdomain>.<platform domain>`.
 *
 * A registration gets a generated address made from its name and a random
 * suffix (`greenwood-k3x9`). A chosen address (`greenwood`), and with it the
 * public homepage at the address's root, is granted on request: the
 * organization asks from Settings and a super admin approves it. The chosen one
 * is stored beside the generated one (`chosen_subdomain`) instead of replacing
 * it, because each workstation keeps the address it enrolled with and would stop
 * reaching its console if that address went away. Both keep working.
 *
 * Organizations registered before addresses were generated keep the one they
 * chose (`address_generated = 0`) and their homepage.
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
