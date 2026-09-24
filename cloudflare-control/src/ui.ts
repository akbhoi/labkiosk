/**
 * The Organization Admin console: which page to build, and the shell to put it in.
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
import { buildAppsWebPage } from "./ui_admin_apps_web";
import { buildStaffPage } from "./ui_admin_staff";
import { buildSettingsPage } from "./ui_admin_settings";

export type AdminPageId =
  | "workstations"
  | "apps-web"
  | "staff"
  | "settings";

export interface DashboardOptions {
  config: LabConfig;
  tenant?: Tenant;
  sites?: PortalSite[];
  baseDomain?: string;
  presets?: BroadcastPreset[];
  staff?: TenantUser[];
  groups?: WorkstationGroup[];
  activePage?: AdminPageId;
  currentUser?: { name: string; email?: string; role: string; permissions?: string[] };
  userPermissions?: string[];
  /**
   * True when the request arrived on a dev host (localhost, 127.0.0.1, ...).
   * There is no organization subdomain there, so the tenant has to travel as
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
  "apps-web": buildAppsWebPage,
  staff: buildStaffPage,
  settings: buildSettingsPage
};

export function renderDashboardHtml(options: DashboardOptions): string {
  const {
    config,
    tenant,
    sites = [],
    baseDomain = "labkiosk.akbhoi.com",
    presets = [],
    staff = [],
    activePage = "workstations",
    currentUser,
    nonce
  } = options;

  const labName = tenant?.name || "Your Organization";
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
      id: "apps-web",
      label: "Apps & Web",
      href: `/admin/apps-web${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
      badge: sites.length
    },
    {
      id: "staff",
      label: "Staff",
      href: `/admin/staff${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      badge: staff.length
    },
    {
      id: "settings",
      label: "Settings",
      href: `/admin/settings${tenantParam}`,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
    }
  ];

  const hasAll = userPermissions.includes("*");
  const navItems = hasAll
    ? allNavItems
    : allNavItems.filter((item) => {
        if (item.id === "apps-web") {
          return (
            userPermissions.includes("apps-web") ||
            userPermissions.includes("broadcast") ||
            userPermissions.includes("portal") ||
            userPermissions.includes("whitelist")
          );
        }
        return userPermissions.includes(item.id);
      });

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
    staff,
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
