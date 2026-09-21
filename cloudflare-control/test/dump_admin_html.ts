/**
 * Dump the rendered admin console for every page, with fixed inputs.
 *
 * Used to prove a refactor of `ui.ts` changed no output: run it before and
 * after, and diff. Not part of the test suite.
 *
 *   npx tsx test/dump_admin_html.ts > /tmp/before.txt
 */

import { renderDashboardHtml } from "../src/ui";
import { LabConfig, Tenant, PortalSite, BroadcastPreset, TenantUser } from "../src/types";

const tenant = {
  id: "tenant-fixed",
  name: "Greenwood High School",
  subdomain: "greenwood",
  status: "active",
  mode: "portal",
  default_url: "https://www.khanacademy.org",
  default_lock_message: "Screens locked by the instructor.",
  enrollment_key: "KEY123",
  created_at: 1700000000,
  home_route: "/",
  tunnel_domain: "greenwood.labkiosk.akbhoi.com",
  broadcast_url: null,
  broadcast_epoch: 0,
  custom_domain: null,
  custom_domain_status: null,
  requested_custom_domain: null,
  requested_subdomain: null
} as unknown as Tenant;

const config: LabConfig = { whitelist: ["khanacademy.org", "scratch.mit.edu", "phet.colorado.edu"] } as LabConfig;

const sites = [
  { id: "s1", tenant_id: "tenant-fixed", title: "Khan Academy", url: "https://www.khanacademy.org", domain: "khanacademy.org", category: "Maths", icon: "K", thumbnail: null, order_index: 0 },
  { id: "s2", tenant_id: "tenant-fixed", title: "Scratch", url: "https://scratch.mit.edu", domain: "scratch.mit.edu", category: "Coding", icon: "S", thumbnail: null, order_index: 1 }
] as unknown as PortalSite[];

const presets = [
  { id: "p1", tenant_id: "tenant-fixed", title: "Chapter 4 Recap", url: "https://example.edu/ch4", created_at: 1700000000 }
] as unknown as BroadcastPreset[];

const teachers = [
  { id: "t1", tenant_id: "tenant-fixed", user_id: "u1", name: "R. Mehta", email: "r.mehta@greenwood.edu", role: "teacher", permissions: ["workstations", "broadcast"], created_at: 1700000000 }
] as unknown as TenantUser[];

const pages = ["workstations", "broadcast", "portal", "whitelist", "teachers", "settings"] as const;

for (const page of pages) {
  const html = renderDashboardHtml({
    config,
    tenant,
    sites,
    presets,
    teachers,
    baseDomain: "labkiosk.akbhoi.com",
    activePage: page,
    currentUser: { name: "Head Teacher", email: "head@greenwood.edu", role: "school_admin" },
    userPermissions: ["*"],
    isDevHost: false,
    nonce: "FIXED-NONCE"
  });
  console.log("===== " + page + " =====");
  console.log(html);
}
