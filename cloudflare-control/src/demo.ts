/**
 * The platform's demo organizations, one per way of testing it.
 *
 * They are the only organizations a platform super admin may open (Rule 2), so the
 * platform can be exercised without reaching into a real organization's data, and
 * each keeps its own workstations, allowlist and broadcasts apart from the others.
 *
 * No imports beyond types: `guard.ts` and `db.ts` both depend on this module, and
 * `guard.ts` already depends on `db.ts`.
 */

import { Tenant } from "./types";

export const DEMO_TENANTS = {
  "web-demo": {
    name: "Web Demo",
    purpose: "Workstations testing the Cloudflare-hosted live site."
  },
  "local-demo": {
    name: "Local VM Demo",
    purpose: "Workstations in a local virtual machine, against a local control plane."
  },
  "docker-demo": {
    name: "Docker Demo",
    purpose: "The Docker workstation simulator."
  }
} as const;

export type DemoSlug = keyof typeof DEMO_TENANTS;
export const DEMO_SLUGS = Object.keys(DEMO_TENANTS) as DemoSlug[];

/** The Cloudflare Tunnel domain the hosted demo's workstations have always used. */
export const WEB_DEMO_TUNNEL_DOMAIN = "demo.labkiosk.akbhoi.com";

/** The demo a super admin lands in when no organization is named. */
export function defaultDemoSlug(onDevHost: boolean): DemoSlug {
  return onDevHost ? "local-demo" : "web-demo";
}

export function isDemoSlug(slug: string | null | undefined): slug is DemoSlug {
  return typeof slug === "string" && Object.prototype.hasOwnProperty.call(DEMO_TENANTS, slug);
}

/**
 * A demo is a demo slug the platform owns. The slug alone is not enough: an
 * organization that registered one of these names before they were reserved
 * would otherwise be opened to the platform administrator.
 */
export function isDemoTenant(tenant: Tenant | null | undefined, superAdminId: string): boolean {
  return Boolean(tenant) && isDemoSlug(tenant!.subdomain) && tenant!.user_id === superAdminId;
}
