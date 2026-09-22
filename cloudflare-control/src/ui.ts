/**
 * The School Admin console: which page to build, and the shell to put it in.
 *
 * This module used to be all of it -- six page renderers, six script
 * renderers, every context panel and both shared script helpers in 2,450
 * lines. Each page now owns its markup, its panel and its client script in one
 * file, and what is left here is the routing between them.
 */

import { LabConfig, Tenant, PortalSite, BroadcastPreset, TenantUser, WorkstationGroup } from "./types";
import { renderLayoutHtml, NavItem, StatItem } from "./ui_layout";
import {
  AdminPageInput,
  AdminPageParts,
  renderApiScopeScript,
  renderSubPanelScripts
} from "./ui_admin_shared";
import { buildWorkstationsPage } from "./ui_admin_workstations";
import { buildBroadcastPage } from "./ui_admin_broadcast";
import { buildPortalPage } from "./ui_admin_portal";
import { buildWhitelistPage } from "./ui_admin_whitelist";
import { buildTeachersPage } from "./ui_admin_teachers";
import { buildSettingsPage } from "./ui_admin_settings";

export type AdminPageId =
  | "workstations"
  | "broadcast"
  | "portal"
  | "whitelist"
  | "teachers"
  | "settings";

export interface DashboardOptions {
  config: LabConfig;
  tenant?: Tenant;
  sites?: PortalSite[];
  baseDomain?: string;
  presets?: BroadcastPreset[];
  teachers?: TenantUser[];
  groups?: WorkstationGroup[];
  activePage?: AdminPageId;
  currentUser?: { name: string; email?: string; role: string; permissions?: string[] };
  userPermissions?: string[];
  /**
   * True when the request arrived on a dev host (localhost, 127.0.0.1, ...).
   * There is no school subdomain there, so the tenant has to travel as
   * ?tenant=<slug> on every link and every API call. Only the request knows
   * this; it used to be guessed from the configured base domain, which is
   * "labkiosk.akbhoi.com" in local development too -- so the guess said
   * "production", the parameter was dropped, and every call answered 400.
   */
  isDevHost?: boolean;
  /**
   * Explicit override indicating whether navigation links must preserve ?tenant=<subdomain>
   * (e.g. when accessing the console on the apex domain or another host where the host
   * itself does not carry the tenant subdomain).
   */
  needsTenantParam?: boolean;
  nonce: string;
}

const PAGE_BUILDERS: Record<AdminPageId, (input: AdminPageInput) => AdminPageParts> = {
  workstations: buildWorkstationsPage,
  broadcast: buildBroadcastPage,
  portal: buildPortalPage,
  whitelist: buildWhitelistPage,
  teachers: buildTeachersPage,
  settings: buildSettingsPage
};

export function renderDashboardHtml(options: DashboardOptions): string {
  const {
    config,
    tenant,
    sites = [],
    baseDomain = "labkiosk.akbhoi.com",
    presets = [],
    teachers = [],
    activePage = "workstations",
    currentUser,
    nonce
  } = options;

  const labName = tenant?.name || "School Computer Lab";
  const subdomain = tenant?.subdomain || "demo";
  const isDev = options.isDevHost === true || !baseDomain;
  const needsTenantParam = options.needsTenantParam !== undefined ? options.needsTenantParam : isDev;
  const tenantParam = needsTenantParam ? `?tenant=${encodeURIComponent(subdomain)}` : "";

  const userPermissions = options.userPermissions || currentUser?.permissions || ["*"];

  const allNavItems: NavItem[] = [
    {
      id: "workstations",
      label: "Workstations",
      href: `/admin/workstations${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`
    },
    {
      id: "broadcast",
      label: "Lesson Broadcast",
      href: `/admin/broadcast${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.93 4.93a10 10 0 0 1 14.14 0"/><path d="M7.76 7.76a6 6 0 0 1 8.48 0"/><circle cx="12" cy="12" r="2"/></svg>`
    },
    {
      id: "portal",
      label: "Portal Apps",
      href: `/admin/portal${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
      badge: sites.length
    },
    {
      id: "whitelist",
      label: "Domain Allowlist",
      href: `/admin/whitelist${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
      badge: config.whitelist.length
    },
    {
      id: "teachers",
      label: "Teachers & Staff",
      href: `/admin/teachers${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      badge: teachers.length
    },
    {
      id: "settings",
      label: "Lab Settings",
      href: `/admin/settings${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
    }
  ];

  const hasAll = userPermissions.includes("*");
  const navItems = hasAll ? allNavItems : allNavItems.filter((item) => userPermissions.includes(item.id));

  const stats: StatItem[] = [
    { label: "Online", value: 0, color: "green", id: "stat-online-count" },
    { label: "Total", value: 0, color: "blue", id: "stat-total-count" },
    { label: "Locked", value: 0, color: "yellow", id: "stat-locked-count" }
  ];

  const pageInput: AdminPageInput = {
    config,
    tenant,
    sites,
    presets,
    teachers,
    groups: options.groups || [],
    baseDomain,
    tenantParam,
    nonce
  };

  const build = PAGE_BUILDERS[activePage] || PAGE_BUILDERS.workstations;
  const page = build(pageInput);

  // The tenant scope has to be in place before any page script runs, and the
  // context panel is part of the shell, so its behaviour ships with every page
  // rather than being re-implemented per page.
  const scriptsHtml =
    renderApiScopeScript(nonce, tenantParam) +
    page.scriptsHtml +
    renderSubPanelScripts(nonce, activePage, tenantParam);

  return renderLayoutHtml({
    title: `${labName} • ${page.title}`,
    brandTitle: labName,
    brandHref: `/admin/workstations${tenantParam}`,
    brandSubtitle: `${subdomain}.${baseDomain} • Control Console`,
    navItems,
    activeNavId: activePage,
    subPanelTitle: page.subPanelTitle,
    subPanelSubtitle: page.subPanelSubtitle,
    subPanelHtml: page.subPanelHtml,
    stats,
    userMeta: currentUser ? { name: currentUser.name, email: currentUser.email, role: currentUser.role } : undefined,
    contentHtml: page.contentHtml,
    modalsHtml: page.modalsHtml || "",
    scriptsHtml,
    nonce
  });
}
