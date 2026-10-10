/**
 * Super Admin Master Console UI
 * Platform owner interface for managing organizations, approving subdomains, and global analytics.
 * Strictly enforces privacy: Super admin cannot access organization consoles except the
 * platform's own demo organizations (web-demo, local-demo, docker-demo).
 */

import { Tenant } from "./types";
import { escapeHtml, escapeAttr } from "./escape";
import { renderLayoutHtml, NavItem, StatItem } from "./ui_layout";
import { DEMO_TENANTS, isDemoTenant } from "./demo";
import { renderTwoFactorPaneHtml, renderTwoFactorScript } from "./ui_two_factor";
import { renderInboxPaneHtml, renderInboxScript, renderInboxSubPanelHtml, renderMailViewBarHtml } from "./ui_super_inbox";

/** A tenant row joined with its admin user and live client counts (see listAllTenants). */
export interface SuperConsoleTenant extends Tenant {
  admin_email: string;
  admin_name: string;
  online_clients: number;
  total_clients: number;
}

export interface SuperConsoleCatalog {
  tag: string;
  name: string;
  direction: string;
  entry_count: number;
  updated_at: number;
}

export interface SuperAdminOptions {
  superAdminEmail: string;
  /** Whose demos these are: a demo row is a demo slug this account owns. */
  superAdminId: string;
  tenants: SuperConsoleTenant[];
  catalogs?: SuperConsoleCatalog[];
  baseDomain?: string;
  activeTab?: "organizations" | "tasks" | "support" | "catalogs" | "system";
  /** Open tasks and mail, and unread and deleted mail, for the badges (src/conversations.ts). */
  inbox?: { openTasks: number; openSupport: number; unreadSupport: number; deletedSupport?: number };
  nonce: string;
}

/** One view of a console tab: a pane the view tabs and the panel's Views list both switch to. */
interface SuperView {
  /** The pane is `#pane-<id>` and the controls carry `data-action="tab-<id>"`. */
  id: string;
  label: string;
  iconSvg: string;
  /** Shown as a badge; a zero is shown only with `showZero`. */
  count?: number;
  showZero?: boolean;
}

function viewCountHtml(view: SuperView, className: string): string {
  if (view.count === undefined || (view.count <= 0 && !view.showZero)) return "";
  return `<span class="${className}">${Math.max(0, Math.floor(view.count))}</span>`;
}

/** The view tabs above a tab's panes. A tab with one view has nothing to switch. */
function renderViewTabsHtml(label: string, views: SuperView[]): string {
  if (views.length < 2) return "";
  return `
    <nav class="segmented-nav" aria-label="${escapeAttr(label)} views">${views
      .map(
        (view, index) => `
      <button type="button" class="segmented-tab${index === 0 ? " active" : ""}" data-action="tab-${escapeAttr(view.id)}">
        ${view.iconSvg}
        <span>${escapeHtml(view.label)}</span>
        ${viewCountHtml(view, "chip-badge")}
      </button>`
      )
      .join("")}
    </nav>
  `;
}

/** The same views in the Level 2 panel, in the same order and under the same names. */
function renderViewListHtml(views: SuperView[]): string {
  if (views.length < 2) return "";
  return `
      <div class="sub-section-title">Views</div>
      <div class="sub-action-list">${views
        .map(
          (view, index) => `
        <button type="button" class="sub-action-item${index === 0 ? " active" : ""}" data-action="tab-${escapeAttr(view.id)}">
          <span>${escapeHtml(view.label)}</span>${viewCountHtml(view, "sub-action-badge")}
        </button>`
        )
        .join("")}
      </div>`;
}

export function renderSuperAdminHtml(data: SuperAdminOptions): string {
  const { superAdminEmail, superAdminId, tenants, baseDomain = "labkiosk.org", activeTab = "organizations", nonce } = data;

  // Registrations are decided in Tasks; this list is an active organization asking for a new address.
  const pendingList = tenants.filter((t) => t.status !== "pending" && t.requested_subdomain);
  const inbox = { deletedSupport: 0, ...(data.inbox || { openTasks: 0, openSupport: 0, unreadSupport: 0 }) };
  const pendingCustomList = tenants.filter((t) => t.custom_domain_status === "pending" && t.requested_custom_domain);
  const totalClients = tenants.reduce((acc, t) => acc + (t.total_clients || 0), 0);
  const totalOnline = tenants.reduce((acc, t) => acc + (t.online_clients || 0), 0);
  const domainRequestCount = pendingList.length + pendingCustomList.length;
  const pendingCount = inbox.openTasks + domainRequestCount;

  const catalogList = data.catalogs || [];
  const catalogRows = catalogList
    .map(
      (c) => `
    <tr>
      <td><span class="cell-title mono">${escapeHtml(c.tag)}</span></td>
      <td>${escapeHtml(c.name)}</td>
      <td><span class="badge badge-neutral">${escapeHtml(c.direction.toUpperCase())}</span></td>
      <td>${Number(c.entry_count) || 0}</td>
      <td class="mono text-xs nowrap">${
        c.updated_at && Number.isFinite(c.updated_at)
          ? escapeHtml(new Date(c.updated_at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC")
          : "-"
      }</td>
      <td>
        <div class="cell-actions"><button class="btn btn-sm btn-danger btn-delete-catalog" data-tag="${escapeAttr(c.tag)}">Delete</button></div>
      </td>
    </tr>
  `
    )
    .join("");

  const pendingSubdomainRows = pendingList
    .map(
      (t) => `
    <tr>
      <td><div class="cell-title">${escapeHtml(t.name)}</div></td>
      <td>${escapeHtml(t.admin_name)} <div class="cell-sub">${escapeHtml(t.admin_email)}</div></td>
      <td>
        <span class="badge badge-yellow mono">
          ${
            t.requested_subdomain
              ? `<b>${escapeHtml(t.requested_subdomain)}</b> (was ${escapeHtml(t.subdomain)})`
              : `<b>${escapeHtml(t.subdomain)}</b>`
          }
        </span>
      </td>
      <td class="mono text-xs nowrap">${escapeHtml(new Date(t.created_at * 1000).toISOString().slice(0, 10))}</td>
      <td>
        <div class="cell-actions">
          <button class="btn btn-sm btn-primary btn-approve-sub" data-tenant="${escapeAttr(t.id)}" data-subdomain="${escapeAttr(t.requested_subdomain || t.subdomain)}">Approve</button>
          <button class="btn btn-sm btn-secondary btn-edit-sub" data-tenant="${escapeAttr(t.id)}">Edit Subdomain</button>
          <button class="btn btn-sm btn-danger btn-reject-sub" data-tenant="${escapeAttr(t.id)}">Reject</button>
        </div>
      </td>
    </tr>
  `
    )
    .join("");

  const pendingCustomRows = pendingCustomList
    .map(
      (t) => `
    <tr>
      <td><div class="cell-title">${escapeHtml(t.name)}</div></td>
      <td>${escapeHtml(t.admin_name)} <div class="cell-sub">${escapeHtml(t.admin_email)}</div></td>
      <td>
        <span class="badge badge-yellow mono">
          ${escapeHtml(t.requested_custom_domain || "")}
        </span>
      </td>
      <td>
        <div class="cell-actions">
          <button class="btn btn-sm btn-primary btn-approve-custom" data-tenant="${escapeAttr(t.id)}" data-domain="${escapeAttr(t.requested_custom_domain || "")}">Approve Domain</button>
          <button class="btn btn-sm btn-danger btn-reject-custom" data-tenant="${escapeAttr(t.id)}">Reject</button>
        </div>
      </td>
    </tr>
  `
    )
    .join("");

  // The demos first: they are the rows a platform administrator actually opens.
  const allRows = [...tenants]
    .sort((a, b) => Number(isDemoTenant(b, superAdminId)) - Number(isDemoTenant(a, superAdminId)))
    .map((t) => {
      const isDemo = isDemoTenant(t, superAdminId);
      const purpose = isDemo ? DEMO_TENANTS[t.subdomain as keyof typeof DEMO_TENANTS].purpose : "";
      const href = `/admin/workstations?tenant=${encodeURIComponent(t.subdomain)}`;
      const menuId = `org-menu-${t.id}`;
      return `
    <tr data-org-status="${escapeAttr(String(t.status))}" data-org-demo="${isDemo ? "1" : "0"}">
      <td class="cell-org">
        <div class="row"><span class="cell-title">${escapeHtml(t.name)}</span>${isDemo ? `<span class="badge badge-blue">Demo</span>` : ""}</div>
        ${isDemo ? `<div class="cell-sub cell-clamp">${escapeHtml(purpose)}</div>` : ""}
      </td>
      <td>${escapeHtml(t.admin_name)} <div class="cell-sub">${escapeHtml(t.admin_email)}</div></td>
      <td>
        <div class="mono text-xs nowrap">${escapeHtml(t.subdomain)}.${escapeHtml(baseDomain)}</div>
        ${
          t.custom_domain
            ? `<div class="row mt-sm"><span class="badge badge-green">Custom</span><span class="mono text-xs">${escapeHtml(t.custom_domain)}</span></div>`
            : t.custom_domain_status === "pending"
              ? `<div class="row mt-sm"><span class="badge badge-yellow">Pending</span><span class="mono text-xs text-muted">${escapeHtml(t.requested_custom_domain || "")}</span></div>`
              : ""
        }
      </td>
      <td>
        <span class="badge ${t.status === "active" ? "badge-green" : t.status === "suspended" ? "badge-red" : "badge-yellow"}">${escapeHtml(String(t.status).charAt(0).toUpperCase() + String(t.status).slice(1))}</span>
      </td>
      <td>
        <span class="row nowrap">
          <span class="stat-dot ${t.online_clients > 0 ? "dot-green" : "dot-neutral"}"></span>
          <span class="stat-val">${Number(t.online_clients) || 0} / ${Number(t.total_clients) || 0}</span>
        </span>
      </td>
      <td>
        <div class="cell-actions">
          ${
            isDemo
              ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-primary">Open Console</a>`
              : `<span class="restricted-note" title="Organization consoles are private to their own staff">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  Private
                </span>`
          }
          <button type="button" class="btn btn-sm btn-ghost btn-icon" popovertarget="${escapeAttr(menuId)}" aria-haspopup="menu" title="More actions" aria-label="More actions">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
          </button>
          <div class="menu-popover" id="${escapeAttr(menuId)}" popover role="menu" aria-label="Organization actions">
            ${isDemo ? "" : `<button type="button" class="menu-item btn-edit-sub" role="menuitem" data-tenant="${escapeAttr(t.id)}">Edit Subdomain</button>`}
            <button type="button" class="menu-item btn-assign-custom" role="menuitem" data-tenant="${escapeAttr(t.id)}">Custom Domain</button>
            ${t.custom_domain ? `<button type="button" class="menu-item menu-item-danger btn-remove-custom" role="menuitem" data-tenant="${escapeAttr(t.id)}">Disconnect Custom Domain</button>` : ""}
            ${
              isDemo
                ? ""
                : t.status === "active"
                ? `<div class="menu-separator" role="separator"></div><button type="button" class="menu-item menu-item-danger btn-suspend" role="menuitem" data-tenant="${escapeAttr(t.id)}">Suspend Organization</button>`
                : t.status === "suspended"
                  ? `<div class="menu-separator" role="separator"></div><button type="button" class="menu-item btn-reactivate" role="menuitem" data-tenant="${escapeAttr(t.id)}">Reactivate Organization</button>`
                  : ""
            }
          </div>
        </div>
      </td>
    </tr>
  `;
    })
    .join("");

  const navItems: NavItem[] = [
    {
      id: "organizations",
      label: "Organizations",
      href: "/super/organizations",
      badge: tenants.length,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`
    },
    {
      id: "tasks",
      label: "Tasks",
      href: "/super/tasks",
      badge: pendingCount > 0 ? pendingCount : undefined,
      badgeTone: "attention",
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`
    },
    {
      id: "support",
      label: "Mail",
      href: "/super/mail",
      badge: inbox.unreadSupport > 0 ? inbox.unreadSupport : undefined,
      badgeTone: "attention",
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`
    },
    {
      id: "catalogs",
      label: "Catalogs",
      href: "/super/catalogs",
      badge: catalogList.length,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`
    },
    {
      id: "system",
      label: "System",
      href: "/super/system",
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`
    }
  ];

  const stats: StatItem[] = [
    { label: "Organizations", value: tenants.length, color: "blue" },
    { label: "Online", value: `${totalOnline} / ${totalClients}`, color: "green" },
    { label: "Tasks", value: pendingCount, color: pendingCount > 0 ? "yellow" : "blue", id: "stat-tasks" }
  ];

  const activeTenantsCount = tenants.filter((t) => t.status === "active").length;
  const suspendedTenantsCount = tenants.filter((t) => t.status === "suspended").length;
  const pendingTenantsCount = tenants.filter((t) => t.status === "pending").length;
  const demoTenantsCount = tenants.filter((t) => isDemoTenant(t, superAdminId)).length;

  // Every tab's views are declared once: the view tabs in the canvas and the
  // Views list in the panel are both rendered from this, so they cannot drift.
  // A request to change an address is a task, so both kinds live under Tasks
  // only; Organizations is the directory, and Mail's views are its folders.
  const viewsByTab: Record<typeof activeTab, SuperView[]> = {
    organizations: [],
    tasks: [
      { id: "requests", label: "Requests", count: inbox.openTasks, iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>` },
      { id: "subdomains", label: "Subdomain changes", count: pendingList.length, iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>` },
      { id: "custom-domains", label: "Custom domains", count: pendingCustomList.length, iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>` }
    ],
    support: [],
    catalogs: [
      { id: "catalogs-list", label: "Installed catalogs", count: catalogList.length, showZero: true, iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>` },
      { id: "catalogs-upload", label: "Upload or replace", iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>` }
    ],
    system: [
      { id: "system-arch", label: "Architecture & health", iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>` },
      { id: "system-audit", label: "Audit log", iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>` },
      { id: "system-two-factor", label: "Two-factor sign-in", iconSvg: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>` }
    ]
  };
  const views = viewsByTab[activeTab] || [];

  const orgFilters: Array<{ id: string; label: string; count: number }> = [
    { id: "all", label: "All", count: tenants.length },
    { id: "active", label: "Active", count: activeTenantsCount },
    { id: "pending", label: "Pending", count: pendingTenantsCount },
    { id: "suspended", label: "Suspended", count: suspendedTenantsCount },
    { id: "demo", label: "Demos", count: demoTenantsCount }
  ];

  // The panel reads the same way on every tab: what you can switch to, then
  // what narrows the list, then the figures, then the note.
  let subPanelTitle = "Organizations";
  let subPanelSubtitle = "Every registered organization";
  let subPanelHtml = "";

  if (activeTab === "organizations") {
    subPanelHtml = `
      <div class="sub-section-title">Show</div>
      <div class="sub-action-list">${orgFilters
        .map(
          (f) => `
        <button type="button" class="sub-action-item${f.id === "all" ? " active" : ""}" data-org-filter="${escapeAttr(f.id)}">
          <span>${escapeHtml(f.label)}</span><span class="sub-action-badge">${f.count}</span>
        </button>`
        )
        .join("")}
      </div>

      <div class="sub-section-title">Address requests</div>
      <div class="sub-action-list">
        <a class="sub-action-item" href="/super/tasks?tab=subdomains">
          <span>Subdomain changes</span><span class="sub-action-badge">${pendingList.length}</span>
        </a>
        <a class="sub-action-item" href="/super/tasks?tab=custom-domains">
          <span>Custom domains</span><span class="sub-action-badge">${pendingCustomList.length}</span>
        </a>
      </div>

      <div class="sub-section-title">Overview</div>
      <div class="kv-list">
        <div class="kv-row"><span>Organizations</span><strong>${tenants.length}</strong></div>
        <div class="kv-row"><span>Workstations online</span><strong>${totalOnline} / ${totalClients}</strong></div>
      </div>

      <div class="sub-section-title">Privacy</div>
      <div class="panel-note">
        An organization's console and telemetry are private to its own staff. Only the platform's demo organizations can be opened from here.
      </div>
    `;
  } else if (activeTab === "tasks") {
    subPanelTitle = "Tasks";
    subPanelSubtitle = "Registrations and requests";
    subPanelHtml = `${renderViewListHtml(views)}
${renderInboxSubPanelHtml("tasks", { open: inbox.openTasks })}`;
  } else if (activeTab === "support") {
    subPanelTitle = "Mail";
    subPanelSubtitle = "All addresses and the contact form";
    subPanelHtml = renderInboxSubPanelHtml("support", {
      open: inbox.openSupport,
      unread: inbox.unreadSupport,
      deleted: inbox.deletedSupport
    });
  } else if (activeTab === "catalogs") {
    subPanelTitle = "Catalogs";
    subPanelSubtitle = "Interface translations";
    subPanelHtml = `${renderViewListHtml(views)}

      <div class="sub-section-title">Overview</div>
      <div class="kv-list">
        <div class="kv-row"><span>Installed languages</span><strong>${catalogList.length}</strong></div>
        <div class="kv-row"><span>Default language</span><strong>English (en-US)</strong></div>
      </div>

      <div class="sub-section-title">Language tags</div>
      <div class="panel-note">
        Catalogs follow BCP 47 language tags (e.g. <code>hi-IN</code>, <code>fr-FR</code>, <code>de-DE</code>, <code>es-ES</code>, <code>ar-SA</code>). Kiosk clients fetch translations dynamically at boot.
      </div>
    `;
  } else {
    subPanelTitle = "System";
    subPanelSubtitle = "Health, audit log and sign-in";
    subPanelHtml = `${renderViewListHtml(views)}

      <div class="sub-section-title">Edge security</div>
      <div class="panel-note">
        Native Web Crypto PBKDF2 authentication with 100,000 iterations. Zero external runtime NPM packages. Immutable RAM overlay client OS.
      </div>
    `;
  }

  // Each console tab renders on its own. The four panes used to be emitted
  // together and hidden with an inline `display`, except #pane-organizations, which
  // carried no display rule and no matching CSS -- so the whole organizations
  // directory, every tenant row included, rendered above the approvals,
  // catalogs and system pages as well.
  const bannerHtml = `    <div class="callout">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <div>
        <strong>Privacy invariant enforced.</strong> Platform Super Administrators cannot access individual organization consoles or view user workstation telemetry. Consoles are accessible solely to authorized organization operators. The platform's own demo organizations (<code>web-demo</code>, <code>local-demo</code> and <code>docker-demo</code>) are available for testing.
      </div>
    </div>
  `;

  const organizationsPaneHtml = `
      <div class="card card-flush">
        <div class="card-head">
          <h2 class="card-title">Registered Organizations (${tenants.length})</h2>
          <div class="filter-chips">${orgFilters
            .map(
              (f) => `
            <button type="button" class="filter-chip${f.id === "all" ? " active" : ""}" data-org-filter="${escapeAttr(f.id)}">${escapeHtml(f.label)}</button>`
            )
            .join("")}
          </div>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Admin Contact</th>
                <th>Address</th>
                <th>Status</th>
                <th>Workstations</th>
                <th class="th-actions"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody id="org-rows">
              ${allRows}
              <tr class="hidden" id="org-rows-empty"><td colspan="6" class="table-empty">No organizations match this filter.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
  `;

  const subdomainRequestsCardHtml = `
      <div class="card">
        <h2 class="card-title">Subdomain Change Requests (${pendingList.length})</h2>
        <p class="card-sub">Active organizations asking to move to a new address. Registrations are decided in Tasks.</p>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Contact</th>
                <th>Requested Subdomain</th>
                <th>Requested</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pendingSubdomainRows || `<tr><td colspan="5" class="table-empty">No subdomain change requests.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
  `;

  const customDomainsCardHtml = `
      <div class="card">
        <h2 class="card-title">Pending Custom Domain Requests (${pendingCustomList.length})</h2>
        <p class="card-sub">Organizations requesting their own custom domains (e.g. <code>kiosk.example.com</code>).</p>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Contact</th>
                <th>Requested Domain</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pendingCustomRows || `<tr><td colspan="4" class="table-empty">No pending custom domain requests.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
  `;

  const catalogsUploadCardHtml = `
      <div class="card">
        <h2 class="card-title">Upload / Replace Translation Catalog</h2>
        <p class="card-sub">Deploy multi-language user interfaces to the first-boot setup wizard and top bar.</p>

        <form id="form-upload-catalog" class="form-narrow">
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label" for="catalog-tag">Language Tag</label>
              <input type="text" id="catalog-tag" required placeholder="e.g. hi-IN or fr-FR" class="form-input">
            </div>
            <div class="form-group">
              <label class="form-label" for="catalog-name">Display Name</label>
              <input type="text" id="catalog-name" placeholder="e.g. Hindi or Français" class="form-input">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="catalog-direction">Direction</label>
            <select id="catalog-direction" class="form-select">
              <option value="ltr">LTR (Left to Right)</option>
              <option value="rtl">RTL (Right to Left)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="catalog-json">Catalog JSON Content</label>
            <textarea id="catalog-json" rows="6" required placeholder='{"bar.home": "Home", ...}' class="form-textarea mono"></textarea>
            <p class="form-hint">A flat map of string to string. Uploaded catalogs are platform-wide: never put anything organization-specific in one.</p>
          </div>
          <button type="submit" class="btn btn-primary">Upload Translation Catalog</button>
        </form>
      </div>
  `;

  const catalogsTableCardHtml = `
      <div class="card">
        <h2 class="card-title">Workstation Interface Catalogs (i18n)</h2>
        <p class="card-sub">Catalogs follow BCP 47 language tags. Kiosk clients fetch translations dynamically at boot.</p>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Tag</th>
                <th>Name</th>
                <th>Direction</th>
                <th>Entries</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${catalogRows || `<tr><td colspan="6" class="table-empty">No interface catalogs uploaded.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
  `;

  const auditCardHtml = `
      <div class="card" id="platform-audit">
        <h2 class="card-title">Platform Action History</h2>
        <p class="card-sub">Catalog changes, and every platform action taken on an organization. An organization\u2019s own activity is not shown here and is not readable from this console.</p>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody id="platform-audit-rows">
              <tr><td colspan="3" class="table-empty">Loading\u2026</td></tr>
            </tbody>
          </table>
        </div>
      </div>
  `;

  const architectureCardHtml = `
      <div class="card" id="platform-architecture">
        <h2 class="card-title">Platform Architecture &amp; Database Health</h2>
        <p class="card-sub">Cloudflare D1 edge database status and real-time operational telemetry.</p>
        <div class="stat-grid">
          <div class="stat-tile">
            <div class="stat-tile-label">Database engine</div>
            <div class="stat-tile-value">Cloudflare D1 (SQLite)</div>
            <div class="stat-tile-hint">Schema verified at boot by assertSchemaCurrent()</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile-label">Runtime dependencies</div>
            <div class="stat-tile-value">0 npm packages</div>
            <div class="stat-tile-hint">Native Web Crypto PBKDF2</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile-label">Client OS overlay</div>
            <div class="stat-tile-value">100% RAM overlay</div>
            <div class="stat-tile-hint">overlayroot="tmpfs:recurse=0", no SSD wear</div>
          </div>
        </div>
      </div>
  `;

  // Mail's view tabs are its folders, with New message beside them; every
  // other tab's are its views.
  const segmentedNavHtml =
    activeTab === "support"
      ? renderMailViewBarHtml({ open: inbox.openSupport, unread: inbox.unreadSupport, deleted: inbox.deletedSupport })
      : renderViewTabsHtml(subPanelTitle, views);

  const panesByTab: Record<typeof activeTab, string> = {
    organizations: organizationsPaneHtml,
    tasks: `
      <div class="tab-pane active" id="pane-requests">
        ${renderInboxPaneHtml("tasks")}
      </div>
      <div class="tab-pane" id="pane-subdomains">
        ${subdomainRequestsCardHtml}
      </div>
      <div class="tab-pane" id="pane-custom-domains">
        ${customDomainsCardHtml}
      </div>
    `,
    support: renderInboxPaneHtml("support"),
    catalogs: `
      <div class="tab-pane active" id="pane-catalogs-list">
        ${catalogsTableCardHtml}
      </div>
      <div class="tab-pane" id="pane-catalogs-upload">
        ${catalogsUploadCardHtml}
      </div>
    `,
    system: `
      <div class="tab-pane active" id="pane-system-arch">
        ${architectureCardHtml}
      </div>
      <div class="tab-pane" id="pane-system-audit">
        ${auditCardHtml}
      </div>
      <div class="tab-pane" id="pane-system-two-factor">
        ${renderTwoFactorPaneHtml()}
      </div>
    `
  };

  const contentHtml = `${bannerHtml}
${segmentedNavHtml}
${panesByTab[activeTab] || organizationsPaneHtml}`;

  const inboxScriptHtml =
    activeTab === "tasks" || activeTab === "support" ? renderInboxScript(nonce, activeTab, baseDomain, domainRequestCount) : "";

  const tabSwitchScriptHtml = `
    <script nonce="${escapeAttr(nonce)}">
      (function() {
        function switchTab(tabId) {
          if (!tabId) return;

          var segTabs = document.querySelectorAll(".segmented-nav .segmented-tab[data-action^='tab-']");
          segTabs.forEach(function(tab) {
            tab.classList.toggle("active", tab.getAttribute("data-action") === "tab-" + tabId);
          });

          var subTabs = document.querySelectorAll("#sub-panel [data-action^='tab-']");
          subTabs.forEach(function(tab) {
            tab.classList.toggle("active", tab.getAttribute("data-action") === "tab-" + tabId);
          });

          var panes = document.querySelectorAll(".tab-pane");
          if (!panes.length) return;
          var found = false;
          panes.forEach(function(pane) {
            var isMatch = pane.id === "pane-" + tabId;
            pane.classList.toggle("active", isMatch);
            if (isMatch) found = true;
          });

          if (!found) {
            panes[0].classList.add("active");
            var firstAction = panes[0].id.replace(/^pane-/, "tab-");
            segTabs.forEach(function(tab) {
              tab.classList.toggle("active", tab.getAttribute("data-action") === firstAction);
            });
            subTabs.forEach(function(tab) {
              tab.classList.toggle("active", tab.getAttribute("data-action") === firstAction);
            });
            tabId = panes[0].id.replace(/^pane-/, "");
          }

          try {
            var url = new URL(window.location.href);
            url.searchParams.set("tab", tabId);
            window.history.replaceState({}, "", url.toString());
          } catch (_) {}
        }

        window.labkioskSwitchTab = switchTab;

        var segNav = document.querySelector(".segmented-nav");
        if (segNav) {
          segNav.addEventListener("click", function(e) {
            var tab = e.target && e.target.closest ? e.target.closest(".segmented-tab") : null;
            if (!tab) return;
            var action = tab.getAttribute("data-action");
            if (action && action.startsWith("tab-")) {
              e.preventDefault();
              switchTab(action.slice(4));
            }
          });
        }

        var subPanel = document.getElementById("sub-panel");
        if (subPanel) {
          subPanel.addEventListener("click", function(e) {
            var item = e.target && e.target.closest ? e.target.closest("[data-action^='tab-']") : null;
            if (!item) return;
            var action = item.getAttribute("data-action");
            if (action && action.startsWith("tab-")) {
              e.preventDefault();
              switchTab(action.slice(4));
            }
          });
        }

        var initialTab = new URLSearchParams(window.location.search).get("tab");
        if (initialTab) {
          switchTab(initialTab);
        }
      })();
    </script>
  `;

  const scriptsHtml = `${inboxScriptHtml}
${tabSwitchScriptHtml}
${activeTab === "system" ? renderTwoFactorScript(nonce) : ""}
    <script nonce="${escapeAttr(nonce)}">
      // The directory filter: the chips above the table and the panel's Show list are one control.
      (function () {
        const controls = document.querySelectorAll("[data-org-filter]");
        const rows = document.querySelectorAll("#org-rows > tr[data-org-status]");
        const empty = document.getElementById("org-rows-empty");
        if (!controls.length || !empty) return;
        function apply(name) {
          let shown = 0;
          rows.forEach((row) => {
            const match = name === "all" || (name === "demo" ? row.dataset.orgDemo === "1" : row.dataset.orgStatus === name);
            row.classList.toggle("hidden", !match);
            if (match) shown += 1;
          });
          empty.classList.toggle("hidden", shown > 0);
          controls.forEach((control) => control.classList.toggle("active", control.dataset.orgFilter === name));
        }
        controls.forEach((control) => control.addEventListener("click", () => apply(control.dataset.orgFilter)));
      })();

      document.querySelectorAll(".btn-approve-sub").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const subdomain = btn.dataset.subdomain;
          const agreed = await lkConfirm({
            title: "Move to '" + subdomain + "'?",
            message: "The console and user portal for this organization move to that address straight away. Workstations enrolled against the old address need reconfiguring.",
            confirmLabel: "Approve"
          });
          if (!agreed) return;
          try {
            const res = await fetch("/api/super/tenants/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId, subdomain })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Approval failed", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-reject-sub").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const agreed = await lkConfirm({
            title: "Decline this address change?",
            message: "The organization keeps its current address. It can ask for a different one later.",
            confirmLabel: "Reject",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch("/api/super/tenants/reject", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Rejection failed", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-approve-custom").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const customDomain = btn.dataset.domain;
          const agreed = await lkConfirm({
            title: "Approve " + customDomain + "?",
            message: "Traffic on that hostname will route to this organization. Their DNS has to point at the worker before it resolves.",
            confirmLabel: "Approve domain"
          });
          if (!agreed) return;
          try {
            const res = await fetch("/api/super/tenants/custom-domain/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId, customDomain })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Custom domain approval failed", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-reject-custom").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const agreed = await lkConfirm({
            title: "Reject this domain request?",
            message: "The organization keeps its subdomain address and can request a different domain later.",
            confirmLabel: "Reject",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch("/api/super/tenants/custom-domain/reject", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to reject custom domain", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-edit-sub").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const newSub = await lkPrompt({
            title: "Assign a subdomain",
            message: "The organization reaches its console and portal at this address. Changing it breaks the old one immediately.",
            label: "Subdomain",
            placeholder: "greenwood",
            hint: "Lowercase letters, digits and hyphens. Reserved slugs are refused.",
            confirmLabel: "Assign"
          });
          if (!newSub) return;
          try {
            const res = await fetch("/api/super/tenants/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId, subdomain: newSub.trim().toLowerCase() })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to assign subdomain", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-assign-custom").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const customDomain = await lkPrompt({
            title: "Assign a custom domain",
            message: "The hostname the organization owns. Their DNS has to point at this worker before it will resolve.",
            label: "Domain",
            placeholder: "kiosk.example.com",
            hint: "A hostname only: no scheme, no path, no port.",
            confirmLabel: "Assign"
          });
          if (!customDomain) return;
          try {
            const res = await fetch("/api/super/tenants/custom-domain/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId, customDomain: customDomain.trim().toLowerCase() })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to assign custom domain", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-remove-custom").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const agreed = await lkConfirm({
            title: "Disconnect this custom domain?",
            message: "The organization falls back to its subdomain. Workstations enrolled against the custom domain will need reconfiguring.",
            confirmLabel: "Disconnect",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch("/api/super/tenants/custom-domain/remove", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to disconnect domain", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-suspend").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const agreed = await lkConfirm({
            title: "Suspend this organization?",
            message: "Its user portal stops serving, its workstations stop reporting and no new one can enrol. Nothing is deleted and you can reactivate at any time.",
            confirmLabel: "Suspend organization",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch("/api/super/tenants/suspend", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to suspend organization", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-reactivate").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const agreed = await lkConfirm({
            title: "Reactivate this organization?",
            message: "Its portal, console and workstation telemetry all resume.",
            confirmLabel: "Reactivate"
          });
          if (!agreed) return;
          try {
            const res = await fetch("/api/super/tenants/reactivate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tenantId })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to reactivate organization", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      const auditRows = document.getElementById("platform-audit-rows");
      if (auditRows) {
        (async function loadPlatformAudit() {
          function placeholder(text) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 3;
            cell.className = "table-empty";
            cell.textContent = text;
            row.appendChild(cell);
            return row;
          }
          try {
            const res = await fetch("/api/super/audit-logs?limit=60");
            const data = await res.json();
            const logs = Array.isArray(data.logs) ? data.logs : [];
            auditRows.replaceChildren();
            if (!logs.length) {
              auditRows.appendChild(placeholder("No platform actions recorded yet."));
              return;
            }
            for (const entry of logs) {
              const row = document.createElement("tr");

              const when = document.createElement("td");
              when.className = "mono text-xs nowrap";
              const date = new Date(entry.created_at * 1000);
              // The viewer's own clock, not UTC; the exact UTC instant is the tooltip.
              const pad = (n) => String(n).padStart(2, "0");
              if (isNaN(date.getTime())) {
                when.textContent = "\u2014";
              } else {
                when.textContent = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
                  " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
                when.title = date.toISOString();
              }
              row.appendChild(when);

              const action = document.createElement("td");
              const badge = document.createElement("span");
              // Red for what takes something away, green for what grants it.
              const removes = /suspend|reject|delete|remove/.test(entry.action);
              const grants = /approve|reactivate|upload/.test(entry.action);
              badge.className = "badge " + (removes ? "badge-red" : grants ? "badge-green" : "badge-blue");
              // textContent: an action string is data, and details carries a
              // organization-supplied subdomain or domain.
              badge.textContent = entry.action;
              action.appendChild(badge);
              row.appendChild(action);

              const detail = document.createElement("td");
              detail.className = "text-muted text-xs cell-detail";
              detail.textContent = entry.details || "\u2014";
              row.appendChild(detail);

              auditRows.appendChild(row);
            }
          } catch (err) {
            auditRows.replaceChildren();
            auditRows.appendChild(placeholder("Could not load the action history."));
          }
        })();
      }

      const catalogForm = document.getElementById("form-upload-catalog");
      if (catalogForm) {
        catalogForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const tag = document.getElementById("catalog-tag").value.trim();
          const name = document.getElementById("catalog-name").value.trim() || tag;
          const direction = document.getElementById("catalog-direction").value;
          const rawJson = document.getElementById("catalog-json").value.trim();

          let parsed;
          try {
            parsed = JSON.parse(rawJson);
          } catch {
            lkToast("Invalid JSON format", "error");
            return;
          }

          try {
            const res = await fetch("/api/super/i18n", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tag, name, direction, catalog: parsed })
            });
            const data = await res.json();
            if (data.status === "ok") {
              lkToastAfterReload("Catalog uploaded: " + data.entries + " entries.", "success");
              window.location.reload();
            } else {
              lkToast(data.error || "Upload failed", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

      document.querySelectorAll(".btn-delete-catalog").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tag = btn.dataset.tag;
          if (!tag) return;
          const agreed = await lkConfirm({
            title: "Delete the '" + tag + "' catalog?",
            message: "Workstations set to that language fall back to English at their next start. The catalogs are platform-wide, so this affects every organization.",
            confirmLabel: "Delete",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch("/api/super/i18n/" + encodeURIComponent(tag), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to delete catalog", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });
    </script>
  `;

  return renderLayoutHtml({
    title: "Super Admin Master Console • Lab Kiosk SaaS",
    brandTitle: "Super Admin Master Console",
    brandSubtitle: `${baseDomain} • Global Governance`,
    brandIconSvg: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
    brandHref: "/super",
    navItems,
    activeNavId: activeTab,
    subPanelTitle,
    subPanelSubtitle,
    subPanelHtml,
    stats,
    userMeta: { name: "Super Admin", email: superAdminEmail, role: "Super Admin" },
    logoutAction: "/api/auth/logout",
    contentHtml,
    scriptsHtml,
    nonce
  });
}
