/**
 * Modern Multi-Page School Admin Dashboard
 * Full-width, clean responsive pages: Workstations, Broadcast, Portal, Whitelist, Teachers, Settings.
 * Zero cramped popup cards.
 */

import { LabConfig, Tenant, PortalSite, BroadcastPreset, TenantUser } from "./types";
import { escapeHtml, escapeAttr, escapeJson, safeHttpUrl } from "./escape";
import { renderLayoutHtml, NavItem, StatItem } from "./ui_layout";

export interface DashboardOptions {
  config: LabConfig;
  tenant?: Tenant;
  sites?: PortalSite[];
  baseDomain?: string;
  presets?: BroadcastPreset[];
  teachers?: TenantUser[];
  activePage?: "workstations" | "broadcast" | "portal" | "whitelist" | "teachers" | "settings";
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
  nonce: string;
}

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
  const tenantParam = isDev ? `?tenant=${encodeURIComponent(subdomain)}` : "";

  const userPermissions = options.userPermissions || currentUser?.permissions || ["*"];

  // Navigation Items
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
      label: "Student Portal",
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

  // Header Stats
  const stats: StatItem[] = [
    { label: "Online", value: 0, color: "green", id: "stat-online-count" },
    { label: "Total", value: 0, color: "blue", id: "stat-total-count" },
    { label: "Locked", value: 0, color: "yellow", id: "stat-locked-count" }
  ];

  // Render Sub-Page Content
  let contentHtml = "";
  let modalsHtml = "";
  let pageTitle = "Workstations";
  let scriptsHtml = "";

  const subPanel = getSubPanelForPage(
    activePage,
    tenant,
    config,
    presets,
    sites,
    teachers,
    tenantParam
  );

  switch (activePage) {
    case "broadcast":
      pageTitle = "Lesson Broadcast Center";
      contentHtml = renderBroadcastPageHtml(tenant, sites, presets);
      scriptsHtml = renderBroadcastScripts(nonce);
      break;
    case "portal":
      pageTitle = "Student Learning Portal Manager";
      contentHtml = renderPortalPageHtml(tenant, sites);
      scriptsHtml = renderPortalScripts(nonce);
      break;
    case "whitelist":
      pageTitle = "Allowed Educational Domains";
      contentHtml = renderWhitelistPageHtml(config.whitelist);
      scriptsHtml = renderWhitelistScripts(nonce);
      break;
    case "teachers":
      pageTitle = "Teachers & Sub-Admin Delegation";
      contentHtml = renderTeachersPageHtml(teachers);
      scriptsHtml = renderTeachersScripts(nonce);
      break;
    case "settings":
      pageTitle = "Lab Settings & Configuration";
      contentHtml = renderSettingsPageHtml(tenant, config, baseDomain);
      scriptsHtml = renderSettingsScripts(nonce);
      break;
    case "workstations":
    default:
      pageTitle = "Workstation Grid & Control";
      contentHtml = renderWorkstationsPageHtml(tenantParam);
      modalsHtml = renderWorkstationsModalsHtml(tenant, presets);
      scriptsHtml = renderWorkstationsScripts(nonce, tenant, config, presets, sites);
      break;
  }

  // The tenant scope has to be in place before any page script runs, and the
  // context panel is part of the shell, so its behaviour ships with every page
  // rather than being re-implemented per page.
  scriptsHtml = renderApiScopeScript(nonce, tenantParam) + scriptsHtml + renderSubPanelScripts(nonce, activePage, tenantParam);

  return renderLayoutHtml({
    title: `${labName} • ${pageTitle}`,
    brandTitle: labName,
    brandHref: `/admin/workstations${tenantParam}`,
    brandSubtitle: `${subdomain}.${baseDomain} • Control Console`,
    navItems,
    activeNavId: activePage,
    subPanelTitle: subPanel.subPanelTitle,
    subPanelSubtitle: subPanel.subPanelSubtitle,
    subPanelHtml: subPanel.subPanelHtml,
    stats,
    userMeta: currentUser ? { name: currentUser.name, email: currentUser.email, role: currentUser.role } : undefined,
    contentHtml,
    modalsHtml,
    scriptsHtml,
    nonce
  });
}

// ============================================================================
// SUB-PANEL GENERATOR FOR MULTI-LEVEL PANELS
// ============================================================================

/**
 * Keeps the tenant on every dashboard API call.
 *
 * In production the school is its own subdomain, so the Host header carries it
 * and a bare "/api/clients" resolves. On a dev host there is no subdomain, the
 * tenant travels as ?tenant=<slug>, and every one of these calls answered 400 --
 * which made the whole console untestable with `pnpm dev`.
 */
function renderApiScopeScript(nonce: string, tenantParam: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        var scope = ${escapeJson(tenantParam)};
        window.labkioskApi = function (path) {
          if (!scope) return path;
          return path + (path.indexOf("?") === -1 ? scope : "&" + scope.slice(1));
        };
      })();
    </script>
  `;
}
/**
 * Behaviour for the Level 2 context panel, on every page that has one.
 *
 * The panel shipped as markup only: `data-filter`, `data-action`, `data-preset`
 * and `data-quick-domain` were read by nothing, the "Add ..." shortcuts pointed
 * at element ids that did not exist, and the four telemetry counts never moved
 * off the zero they were rendered with. Every control in it was inert.
 *
 * Handlers are delegated from the panel itself, so a page that does not use a
 * given control simply has no element carrying it.
 */
function renderSubPanelScripts(nonce: string, activePage: string, tenantParam: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        var panel = document.getElementById("sub-panel");
        if (!panel) return;
        var activePage = ${escapeJson(activePage)};
        var workstationsHref = "/admin/workstations" + ${escapeJson(tenantParam)};

        /** Bring a field into view and put the caret in it. */
        function focusField(id) {
          var field = document.getElementById(id);
          if (!field) return;
          field.scrollIntoView({ behavior: "smooth", block: "center" });
          field.focus({ preventScroll: true });
        }

        /**
         * Run one of the workstation batch commands. The toolbar on the
         * workstations page owns the real handlers, so click through to it;
         * from any other page there is nothing to click, so navigate there.
         */
        function runToolbarAction() {
          for (var i = 0; i < arguments.length; i++) {
            var button = document.getElementById(arguments[i]);
            if (button) {
              button.click();
              return;
            }
          }
          window.location.href = workstationsHref;
        }

        function setActiveFilter(button) {
          var buttons = panel.querySelectorAll("[data-filter]");
          for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove("active");
          button.classList.add("active");
          window.labkioskApplyFilter(button.getAttribute("data-filter"));
        }

        panel.addEventListener("click", function (event) {
          var target = event.target && event.target.closest ? event.target.closest("[data-focus], [data-filter], [data-action], [data-preset], [data-quick-domain]") : null;
          if (!target) return;

          var focusId = target.getAttribute("data-focus");
          if (focusId) {
            event.preventDefault();
            focusField(focusId);
            return;
          }

          if (target.hasAttribute("data-filter")) {
            event.preventDefault();
            if (typeof window.labkioskApplyFilter === "function") setActiveFilter(target);
            return;
          }

          var preset = target.getAttribute("data-preset");
          if (preset) {
            event.preventDefault();
            var urlField = document.getElementById("broadcast-url");
            if (urlField) {
              urlField.value = preset;
              urlField.focus({ preventScroll: true });
              urlField.scrollIntoView({ behavior: "smooth", block: "center" });
            }
            return;
          }

          var quickDomain = target.getAttribute("data-quick-domain");
          if (quickDomain) {
            event.preventDefault();
            var field = document.getElementById("domain-input");
            var form = document.getElementById("add-domain-form");
            if (field && form) {
              field.value = quickDomain;
              form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
            }
            return;
          }

          var action = target.getAttribute("data-action");
          if (!action) return;
          event.preventDefault();
          if (action === "open-broadcast") runToolbarAction("btn-open-broadcast");
          else if (action === "open-lock-all") {
            // The lock dialog carries the announcement students will read. The
            // toolbar button locks immediately with the saved default; this is
            // the path for setting a message first.
            if (typeof window.labkioskOpenLockDialog === "function") window.labkioskOpenLockDialog();
            else window.location.href = workstationsHref;
          }
          else if (action === "open-unlock-all") runToolbarAction("btn-unlock-all");
          else if (action === "open-reboot-all") runToolbarAction("btn-reboot-all");
          // The broadcast page calls the same thing "Stop Broadcast".
          else if (action === "reset-portal" || action === "quick-reset-portal") runToolbarAction("btn-reset-portal", "btn-stop-broadcast");
        });

        // Pages other than the grid cannot filter anything; leave the buttons out
        // of the tab order there rather than offering a control that cannot work.
        if (activePage !== "workstations") {
          var filters = panel.querySelectorAll("[data-filter]");
          for (var j = 0; j < filters.length; j++) filters[j].setAttribute("disabled", "disabled");
        }
      })();
    </script>
  `;
}
function getSubPanelForPage(
  page: "workstations" | "broadcast" | "portal" | "whitelist" | "teachers" | "settings",
  tenant?: Tenant,
  config?: LabConfig,
  presets: BroadcastPreset[] = [],
  sites: PortalSite[] = [],
  teachers: TenantUser[] = [],
  tenantParam: string = ""
): { subPanelTitle: string; subPanelSubtitle: string; subPanelHtml: string } {
  switch (page) {
    case "broadcast":
      return {
        subPanelTitle: "Broadcast Tools",
        subPanelSubtitle: "Synchronize lesson screens",
        subPanelHtml: `
          <div class="sub-section-title">Active Lesson Status</div>
          <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); margin-bottom: 12px;">
            <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase;">Current Broadcast URL</div>
            <div style="font-size: 12px; font-weight: 700; color: #93c5fd; margin-top: 4px; word-break: break-all; font-family: 'JetBrains Mono', monospace;" id="sub-active-url">${escapeHtml(tenant?.default_url || "None (Student Portal Active)")}</div>
          </div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" id="sub-btn-reset-portal" data-action="quick-reset-portal">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Clear / Release to Portal
              </span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Quick Educational Presets</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-preset="https://scratch.mit.edu">
              <span>Scratch Programming</span>
            </button>
            <button type="button" class="sub-action-item" data-preset="https://phet.colorado.edu">
              <span>PhET Simulations</span>
            </button>
            <button type="button" class="sub-action-item" data-preset="https://www.khanacademy.org">
              <span>Khan Academy</span>
            </button>
            <button type="button" class="sub-action-item" data-preset="https://en.wikipedia.org">
              <span>Wikipedia</span>
            </button>
            ${presets
              .map(
                (p) => `
              <button type="button" class="sub-action-item" data-preset="${escapeAttr(p.url)}">
                <span>${escapeHtml(p.title)}</span>
              </button>
            `
              )
              .join("")}
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Navigation</div>
          <div class="sub-action-list">
            <a href="/admin/workstations${tenantParam}" class="sub-action-item">
              <span>← Back to Workstations</span>
            </a>
          </div>
        `
      };

    case "portal":
      return {
        subPanelTitle: "Portal Manager",
        subPanelSubtitle: "Curate educational resources",
        subPanelHtml: `
          <div class="sub-section-title">Actions</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-focus="app-title">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add App Card
              </span>
            </button>
            <a href="/?tenant=${encodeURIComponent(tenant?.subdomain || "demo")}" target="_blank" rel="noopener noreferrer" class="sub-action-item">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                Preview Student Portal
              </span>
            </a>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Summary</div>
          <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 13px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: var(--text-muted);">Total Apps:</span>
              <strong>${sites.length}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-muted);">Current Mode:</span>
              <span class="badge ${tenant?.mode === "single_url" ? "badge-yellow" : "badge-green"}">${tenant?.mode === "single_url" ? "Single URL" : "App Grid"}</span>
            </div>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Navigation</div>
          <div class="sub-action-list">
            <a href="/admin/workstations${tenantParam}" class="sub-action-item">
              <span>← Back to Workstations</span>
            </a>
          </div>
        `
      };

    case "whitelist":
      return {
        subPanelTitle: "Domain Allowlist",
        subPanelSubtitle: "Chromium policy firewall",
        subPanelHtml: `
          <div class="sub-section-title">Actions</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-focus="domain-input">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add Domain
              </span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Quick Presets</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-quick-domain="scratch.mit.edu">
              <span>+ scratch.mit.edu</span>
            </button>
            <button type="button" class="sub-action-item" data-quick-domain="phet.colorado.edu">
              <span>+ phet.colorado.edu</span>
            </button>
            <button type="button" class="sub-action-item" data-quick-domain="khanacademy.org">
              <span>+ khanacademy.org</span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Policy Info</div>
          <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 12px; color: var(--text-muted); line-height: 1.4;">
            Permitted domains are merged into Chromium's enterprise managed policy (<code>URLAllowlist</code>) upon each 3-second heartbeat.
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Navigation</div>
          <div class="sub-action-list">
            <a href="/admin/workstations${tenantParam}" class="sub-action-item">
              <span>← Back to Workstations</span>
            </a>
          </div>
        `
      };

    case "teachers":
      return {
        subPanelTitle: "Staff Directory",
        subPanelSubtitle: "Sub-admin delegation",
        subPanelHtml: `
          <div class="sub-section-title">Actions</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-focus="teacher-name">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                Add Staff Member
              </span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Roles &amp; Access</div>
          <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 12px; color: var(--text-muted); line-height: 1.5;">
            Teachers can be granted granular permissions:
            <ul style="padding-left: 16px; margin-top: 6px;">
              <li>Workstation control</li>
              <li>Lesson broadcasting</li>
              <li>Portal curation</li>
              <li>Domain allowlist</li>
              <li>Lab settings</li>
            </ul>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Navigation</div>
          <div class="sub-action-list">
            <a href="/admin/workstations${tenantParam}" class="sub-action-item">
              <span>← Back to Workstations</span>
            </a>
          </div>
        `
      };

    case "settings":
      return {
        subPanelTitle: "Lab Configuration",
        subPanelSubtitle: "Settings & preferences",
        subPanelHtml: `
          <div class="sub-section-title">Jump to Section</div>
          <div class="sub-action-list">
            <a href="#section-general" class="sub-action-item">
              <span>General Information</span>
            </a>
            <a href="#section-subdomain" class="sub-action-item">
              <span>Subdomain &amp; Routing</span>
            </a>
            <a href="#section-custom-domain" class="sub-action-item">
              <span>Custom Domain</span>
            </a>
            <a href="#section-routing" class="sub-action-item">
              <span>Kiosk Routing &amp; Home URL</span>
            </a>
            <a href="#section-vnc" class="sub-action-item">
              <span>VNC &amp; Remote Control</span>
            </a>
            <a href="#section-enrollment" class="sub-action-item">
              <span>Workstation Enrollment Key</span>
            </a>
            <a href="#section-password" class="sub-action-item">
              <span>Admin Password</span>
            </a>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Security Audit</div>
          <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 12px; color: var(--text-muted); line-height: 1.4;">
            Passwords use PBKDF2-HMAC-SHA256 (100k rounds) via WebCrypto. Device enrollment keys use cryptographically secure random bytes.
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Navigation</div>
          <div class="sub-action-list">
            <a href="/admin/workstations${tenantParam}" class="sub-action-item">
              <span>← Back to Workstations</span>
            </a>
          </div>
        `
      };

    case "workstations":
    default:
      return {
        subPanelTitle: "Workstations",
        subPanelSubtitle: "Telemetry & batch commands",
        subPanelHtml: `
          <div class="sub-section-title">Telemetry Filters</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item active" data-filter="all">
              <span>All Workstations</span>
              <span class="sub-action-badge" id="sub-filter-all-count">0</span>
            </button>
            <button type="button" class="sub-action-item" data-filter="online">
              <span>Online (Active)</span>
              <span class="sub-action-badge" id="sub-filter-online-count" style="color: #6ee7b7;">0</span>
            </button>
            <button type="button" class="sub-action-item" data-filter="offline">
              <span>Offline / Standby</span>
              <span class="sub-action-badge" id="sub-filter-offline-count">0</span>
            </button>
            <button type="button" class="sub-action-item" data-filter="locked">
              <span>Locked Screens</span>
              <span class="sub-action-badge" id="sub-filter-locked-count" style="color: #fde68a;">0</span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Classroom Commands</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-action="open-broadcast">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.93 4.93a10 10 0 0 1 14.14 0"/><path d="M7.76 7.76a6 6 0 0 1 8.48 0"/><circle cx="12" cy="12" r="2"/></svg>
                Broadcast URL
              </span>
            </button>
            <button type="button" class="sub-action-item" data-action="open-lock-all">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Lock All Screens
              </span>
            </button>
            <button type="button" class="sub-action-item" data-action="open-unlock-all">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                Unlock All
              </span>
            </button>
            <button type="button" class="sub-action-item" data-action="reset-portal">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Reset to Portal
              </span>
            </button>
            <button type="button" class="sub-action-item" data-action="open-reboot-all" style="color: #fca5a5;">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                Reboot All PCs
              </span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Quick Navigation</div>
          <div class="sub-action-list">
            <a href="/admin/broadcast${tenantParam}" class="sub-action-item">
              <span>Lesson Broadcast</span>
              <span style="color: var(--text-muted);">→</span>
            </a>
            <a href="/admin/portal${tenantParam}" class="sub-action-item">
              <span>Portal Apps (${sites.length})</span>
              <span style="color: var(--text-muted);">→</span>
            </a>
            <a href="/admin/whitelist${tenantParam}" class="sub-action-item">
              <span>Allowed Domains (${config?.whitelist?.length || 0})</span>
              <span style="color: var(--text-muted);">→</span>
            </a>
            <a href="/admin/settings${tenantParam}" class="sub-action-item">
              <span>Lab Settings</span>
              <span style="color: var(--text-muted);">→</span>
            </a>
          </div>
        `
      };
  }
}

// ============================================================================
// 1. WORKSTATIONS PAGE
// ============================================================================

/**
 * The workstation grid and its batch-command toolbar.
 *
 * Allowed Domains, Portal Apps and Settings are links to their own pages, not
 * modals. They used to be both: a second, unstyled copy of each editor lived
 * in a dialog here, and the settings copy had no save handler at all.
 */
function renderWorkstationsPageHtml(tenantParam: string): string {
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Workstation Grid &amp; Remote Control</h1>
        <p class="page-desc">Real-time classroom telemetry, live screen monitoring, and remote command execution.</p>
      </div>
      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
        <button type="button" class="btn btn-warning" id="btn-lock-all">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Lock All Screens
        </button>
        <button type="button" class="btn btn-secondary" id="btn-unlock-all">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
          Unlock All
        </button>
        <button type="button" class="btn btn-primary" id="btn-open-broadcast">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4.93 4.93a10 10 0 0 1 14.14 0"/><path d="M7.76 7.76a6 6 0 0 1 8.48 0"/><circle cx="12" cy="12" r="2"/></svg>
          Broadcast URL
        </button>
        <a class="btn btn-secondary" href="/admin/whitelist${tenantParam}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Allowed Domains
        </a>
        <a class="btn btn-secondary" href="/admin/portal${tenantParam}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          Portal Apps
        </a>
        <a class="btn btn-secondary" href="/admin/settings${tenantParam}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Settings
        </a>
        <button type="button" class="btn btn-primary" id="btn-reset-portal">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          Reset to Portal
        </button>
        <button type="button" class="btn btn-danger" id="btn-reboot-all">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          Reboot All
        </button>
      </div>
    </div>

    <div class="kiosk-grid" id="kiosk-grid">
      <div class="empty-lab-state">
        <p class="empty-lab-title">Connecting to classroom telemetry...</p>
        <p>Workstations will appear here automatically once enrolled.</p>
      </div>
    </div>
  `;
}

/** Remote control, broadcast and lock-screen dialogs for the workstation grid. */
function renderWorkstationsModalsHtml(tenant?: Tenant, presets: BroadcastPreset[] = []): string {
  return `
    <!-- VNC Remote Control Modal -->
    <div class="modal-overlay" id="vnc-modal">
      <div class="modal-box" style="max-width: 1000px; width: 95%; height: 85vh; display: flex; flex-direction: column; padding: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h3 id="vnc-modal-title" style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
            <span class="stat-dot dot-green"></span> Live Remote Control
          </h3>
          <button type="button" class="modal-close" id="btn-close-vnc" aria-label="Close dialog">✕</button>
        </div>
        <div id="vnc-notice" style="display: none; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #93c5fd; margin-bottom: 10px;"></div>
        <iframe id="vnc-frame" src="about:blank" style="flex: 1; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: #000;" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      </div>
    </div>

    <!-- Broadcast URL Modal -->
    <div class="modal-overlay" id="url-modal">
      <div class="modal-box" style="max-width: 540px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 id="url-modal-title" style="font-size: 16px; font-weight: 700;">Broadcast URL to All Workstations</h3>
          <button type="button" class="modal-close" id="btn-cancel-broadcast" aria-label="Close dialog">✕</button>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Enter an educational website URL to immediately navigate all student workstations.
        </p>
        <div style="margin-bottom: 14px;">
          <input type="url" id="target-url-input" class="form-input" placeholder="https://..." value="${escapeHtml(tenant?.default_url || "")}" style="width: 100%; font-family: 'JetBrains Mono', monospace; font-size: 13px;">
        </div>
        <div id="broadcast-error" style="color: var(--danger); font-size: 12px; margin-bottom: 10px; min-height: 16px;"></div>
        <div style="margin-bottom: 16px;">
          <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px;">Quick Shortcuts</div>
          <div id="broadcast-quick-links" style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px;">
            <button type="button" class="btn btn-sm btn-secondary" data-url="https://scratch.mit.edu">Scratch</button>
            <button type="button" class="btn btn-sm btn-secondary" data-url="https://phet.colorado.edu">PhET Sims</button>
            <button type="button" class="btn btn-sm btn-secondary" data-url="https://www.khanacademy.org">Khan Academy</button>
            <button type="button" class="btn btn-sm btn-secondary" data-url="https://en.wikipedia.org">Wikipedia</button>
          </div>
          <div id="broadcast-custom-shortcuts" style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${presets.map((p) => `<button type="button" class="btn btn-sm btn-secondary" data-url="${escapeAttr(p.url)}">${escapeHtml(p.title)}</button>`).join("")}
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" id="btn-reset-broadcast">Reset to Portal</button>
          <button type="button" class="btn btn-primary" id="btn-send-broadcast">Broadcast Now</button>
        </div>
      </div>
    </div>

    <!-- Lock Screen Modal -->
    <div class="modal-overlay" id="lock-modal">
      <div class="modal-box" style="max-width: 500px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 id="lock-modal-title" style="font-size: 16px; font-weight: 700;">Lock Workstations</h3>
          <button type="button" class="modal-close" id="btn-cancel-lock" aria-label="Close dialog">✕</button>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Freeze all student screens with an announcement message. Keystrokes and shortcuts are locked.
        </p>
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Announcement Message</label>
          <input type="text" id="lock-msg-input" class="form-input" value="${escapeHtml(tenant?.default_lock_message || "Screens locked by the instructor. Please look to the front.")}" maxlength="280" style="width: 100%;">
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" id="btn-cancel-lock-action">Cancel</button>
          <button type="button" class="btn btn-warning" id="btn-send-lock">Lock All Workstations</button>
        </div>
      </div>
    </div>

  `;
}

function renderWorkstationsScripts(
  nonce: string,
  tenant?: Tenant,
  config?: LabConfig,
  presets: BroadcastPreset[] = [],
  sites: PortalSite[] = []
): string {
  const tunnelDomain = tenant?.tunnel_domain || config?.tunnelDomain || "demo.labkiosk.akbhoi.com";
  const isDemo = tenant?.subdomain === "demo";

  return `
    <script nonce="${escapeAttr(nonce)}">
      const TUNNEL_DOMAIN = ${escapeJson(tunnelDomain)};
      const IS_DEMO = ${isDemo ? "true" : "false"};
      let clientsData = {};

      function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
      }

      function createCardElement(id) {
        const card = el("div", "card kiosk-card");
        card.id = "card-" + id;
        card.style.cssText = "display: flex; flex-direction: column; gap: 12px; padding: 16px; transition: transform 0.2s, border-color 0.2s;";

        const head = el("div");
        head.style.cssText = "display: flex; justify-content: space-between; align-items: center;";
        const idWrap = el("div");
        idWrap.style.cssText = "display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px;";
        const dot = el("span", "stat-dot dot-red");
        dot.dataset.role = "dot";
        idWrap.append(dot, el("span", null, id));

        const badges = el("div");
        badges.style.cssText = "display: flex; align-items: center; gap: 6px;";
        const lockBadge = el("span", "badge badge-yellow", "LOCKED");
        lockBadge.dataset.role = "lock-badge";
        lockBadge.style.display = "none";
        const removeBtn = el("button", "btn btn-sm btn-secondary", "✕");
        removeBtn.title = "Remove " + id;
        removeBtn.addEventListener("click", () => removeClient(id));
        badges.append(lockBadge, removeBtn);
        head.append(idWrap, badges);

        const thumbBox = el("div");
        thumbBox.style.cssText = "position: relative; width: 100%; aspect-ratio: 16/10; background: #000; border-radius: 8px; overflow: hidden; border: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: center;";
        const thumb = document.createElement("img");
        thumb.dataset.role = "thumb";
        thumb.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: none;";
        thumb.alt = "Screen preview";
        const placeholder = el("div", null, "Standby / Offline");
        placeholder.dataset.role = "placeholder";
        placeholder.style.cssText = "color: var(--text-muted); font-size: 12px; font-weight: 600;";
        thumbBox.append(thumb, placeholder);

        const actions = el("div");
        actions.style.cssText = "display: grid; grid-template-columns: 1fr 1fr; gap: 8px;";
        const vncBtn = el("button", "btn btn-sm btn-primary", "Remote Control");
        vncBtn.addEventListener("click", () => openVncSession(id));
        const lockBtn = el("button", "btn btn-sm btn-secondary", "Lock");
        lockBtn.addEventListener("click", () => sendCommand(id, "lock"));
        const unlockBtn = el("button", "btn btn-sm btn-secondary", "Unlock");
        unlockBtn.addEventListener("click", () => sendCommand(id, "unlock"));
        const reloadBtn = el("button", "btn btn-sm btn-secondary", "Reload");
        reloadBtn.addEventListener("click", () => sendCommand(id, "reload"));
        actions.append(vncBtn, lockBtn, unlockBtn, reloadBtn);

        const footer = el("div");
        footer.style.cssText = "display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); padding-top: 4px; border-top: 1px solid var(--border-subtle);";
        const urlSpan = el("span", null, "Ready");
        urlSpan.dataset.role = "url";
        urlSpan.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;";
        const ipSpan = el("span", null, "--");
        ipSpan.dataset.role = "ip";
        ipSpan.style.cssText = "font-family: 'JetBrains Mono', monospace;";
        footer.append(urlSpan, ipSpan);

        card.append(head, thumbBox, actions, footer);
        return card;
      }

      function updateCard(card, id, client) {
        const dot = card.querySelector('[data-role="dot"]');
        const thumb = card.querySelector('[data-role="thumb"]');
        const placeholder = card.querySelector('[data-role="placeholder"]');
        const lockBadge = card.querySelector('[data-role="lock-badge"]');
        const urlSpan = card.querySelector('[data-role="url"]');
        const ipSpan = card.querySelector('[data-role="ip"]');

        if (client && client.online) {
          dot.className = "stat-dot dot-green";
          if (client.thumbnail && client.thumbnail.startsWith("data:image/")) {
            thumb.src = client.thumbnail;
            thumb.style.display = "block";
            placeholder.style.display = "none";
          } else {
            thumb.removeAttribute("src");
            thumb.style.display = "none";
            placeholder.style.display = "block";
            placeholder.textContent = "Live (No Frame)";
          }
          lockBadge.style.display = client.isLocked ? "inline-flex" : "none";
          try {
            urlSpan.textContent = new URL(client.activeUrl).hostname;
          } catch {
            urlSpan.textContent = client.activeUrl || "Ready";
          }
        } else {
          dot.className = "stat-dot dot-red";
          thumb.removeAttribute("src");
          thumb.style.display = "none";
          placeholder.style.display = "block";
          placeholder.textContent = "Standby / Offline";
          lockBadge.style.display = "none";
          urlSpan.textContent = "Offline";
        }
        ipSpan.textContent = (client && client.ip) || "--";
      }

      async function pollClients() {
        try {
          const res = await fetch(labkioskApi("/api/clients"));
          if (!res.ok) return;
          const data = await res.json();
          clientsData = data.clients || {};

          const grid = document.getElementById("kiosk-grid");
          const ids = Object.keys(clientsData).sort();

          if (!ids.length) {
            grid.innerHTML = '<div class="empty-lab-state"><p class="empty-lab-title">No Thin Clients Connected</p><p>Workstations appear here once enrolled with the school key.</p></div>';
            document.getElementById("stat-online-count").textContent = "0";
            document.getElementById("stat-total-count").textContent = "0";
            document.getElementById("stat-locked-count").textContent = "0";
            setPanelCounts(0, 0, 0, 0);
            return;
          }

          const empty = grid.querySelector(".empty-lab-state");
          if (empty) empty.remove();

          for (const card of Array.from(grid.querySelectorAll(".kiosk-card"))) {
            if (!clientsData[card.id.replace("card-", "")]) card.remove();
          }

          let online = 0, locked = 0;
          for (const id of ids) {
            let card = document.getElementById("card-" + id);
            if (!card) {
              card = createCardElement(id);
              grid.appendChild(card);
            }
            const c = clientsData[id];
            if (c && c.online) online++;
            if (c && c.online && c.isLocked) locked++;
            updateCard(card, id, c);
          }

          document.getElementById("stat-online-count").textContent = String(online);
          document.getElementById("stat-total-count").textContent = String(ids.length);
          document.getElementById("stat-locked-count").textContent = String(locked);
          setPanelCounts(ids.length, online, ids.length - online, locked);
          applyFilter(activeFilter);
        } catch (err) {
          console.warn("Telemetry poll:", err);
        }
      }

      function openVncSession(id) {
        document.getElementById("vnc-modal-title").textContent = "Live Remote Control: " + id;
        const client = clientsData[id] || {};
        const host = window.location.hostname;
        let base = "";

        if (client.remoteHost) {
          base = "https://" + client.remoteHost;
        } else if (host === "localhost" || host === "127.0.0.1" || host.includes("docker")) {
          base = "http://" + host + ":6080";
        } else if (IS_DEMO) {
          base = "https://" + encodeURIComponent(id.toLowerCase()) + "." + TUNNEL_DOMAIN;
        } else if (TUNNEL_DOMAIN && TUNNEL_DOMAIN !== "lab.myschool.edu") {
          base = "https://" + encodeURIComponent(id.toLowerCase()) + "." + TUNNEL_DOMAIN;
        } else {
          base = "http://localhost:6080";
          const notice = document.getElementById("vnc-notice");
          notice.textContent = "Notice: Cloudflare Tunnel domain is not configured for this school. Remote control is accessible via local simulator (port 6080) or after configuring a tunnel in Lab Settings.";
          notice.style.display = "block";
        }

        const params = new URLSearchParams({ autoconnect: "true", resize: "scale" });
        if (client.vncPassword) params.set("password", client.vncPassword);
        document.getElementById("vnc-frame").src = base + "/vnc.html?" + params.toString();
        document.getElementById("vnc-modal").classList.add("active");
      }

      document.getElementById("btn-close-vnc").addEventListener("click", () => {
        document.getElementById("vnc-modal").classList.remove("active");
        document.getElementById("vnc-frame").src = "about:blank";
        document.getElementById("vnc-notice").style.display = "none";
      });

      async function sendCommand(target, action, extra = {}) {
        try {
          const res = await fetch(labkioskApi("/api/command"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target, action, ...extra })
          });
          const data = await res.json();
          if (data.status === "ok") {
            pollClients();
          } else {
            alert(data.error || "Command failed");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      }

      async function removeClient(clientId) {
        if (!confirm("Decommission " + clientId + "? It must be re-enrolled to reconnect.")) return;
        try {
          const res = await fetch(labkioskApi("/api/clients/remove"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId })
          });
          const data = await res.json();
          if (data.status === "ok") {
            const card = document.getElementById("card-" + clientId);
            if (card) card.remove();
            delete clientsData[clientId];
            pollClients();
          } else {
            alert(data.error || "Failed to remove workstation");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      }

      document.getElementById("btn-lock-all").addEventListener("click", () => sendCommand("all", "lock"));
      document.getElementById("btn-unlock-all").addEventListener("click", () => sendCommand("all", "unlock"));
      document.getElementById("btn-reset-portal").addEventListener("click", () => sendCommand("all", "navigate", { resetPortal: true }));
      document.getElementById("btn-reboot-all").addEventListener("click", () => {
        if (confirm("Are you sure you want to REBOOT all lab computers?")) sendCommand("all", "reboot");
      });

      // ------------------------------------------------ context panel hooks
      // The Level 2 panel is rendered by the shell and has no access to this
      // closure, so the two things it needs are published on window.

      var activeFilter = "all";

      /**
       * The four tallies beside the panel filters. They were server-rendered
       * as zero and then never touched, so the panel always claimed an empty
       * lab however many workstations were reporting.
       */
      function setPanelCounts(total, online, offline, locked) {
        var counts = {
          "sub-filter-all-count": total,
          "sub-filter-online-count": online,
          "sub-filter-offline-count": offline,
          "sub-filter-locked-count": locked
        };
        for (var id in counts) {
          var el = document.getElementById(id);
          if (el) el.textContent = String(counts[id]);
        }
      }

      /** Does this workstation belong in the current filter? */
      function matchesFilter(client) {
        var online = !!(client && client.online);
        if (activeFilter === "online") return online;
        if (activeFilter === "offline") return !online;
        if (activeFilter === "locked") return online && !!client.isLocked;
        return true;
      }

      /** Show only the cards the filter keeps, and say so when none remain. */
      function applyFilter(name) {
        activeFilter = name || "all";
        var grid = document.getElementById("kiosk-grid");
        if (!grid) return;
        var shown = 0;
        var cards = grid.querySelectorAll(".kiosk-card");
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];
          var keep = matchesFilter(clientsData[card.id.replace("card-", "")]);
          card.style.display = keep ? "" : "none";
          if (keep) shown++;
        }
        var note = document.getElementById("filter-empty-note");
        if (cards.length && !shown) {
          if (!note) {
            note = document.createElement("div");
            note.id = "filter-empty-note";
            note.className = "empty-lab-state";
            grid.appendChild(note);
          }
          note.textContent = "No workstations match this filter.";
        } else if (note) {
          note.remove();
        }
      }
      window.labkioskApplyFilter = applyFilter;

      /** Open the lock dialog so a teacher can set the announcement text. */
      window.labkioskOpenLockDialog = function () {
        openModal("lock-modal");
      };

      function openModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.add("active");
      }
      function closeModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.remove("active");
      }

      const btnOpenBroadcast = document.getElementById("btn-open-broadcast");
      if (btnOpenBroadcast) btnOpenBroadcast.addEventListener("click", () => openModal("url-modal"));
      const btnCancelBroadcast = document.getElementById("btn-cancel-broadcast");
      if (btnCancelBroadcast) btnCancelBroadcast.addEventListener("click", () => closeModal("url-modal"));

      const btnSendBroadcast = document.getElementById("btn-send-broadcast");
      if (btnSendBroadcast) {
        btnSendBroadcast.addEventListener("click", () => {
          const input = document.getElementById("target-url-input");
          const url = input ? input.value.trim() : "";
          if (url) {
            sendCommand("all", "navigate", { url });
            closeModal("url-modal");
          }
        });
      }
      const btnResetBroadcast = document.getElementById("btn-reset-broadcast");
      if (btnResetBroadcast) {
        btnResetBroadcast.addEventListener("click", () => {
          sendCommand("all", "navigate", { resetPortal: true });
          closeModal("url-modal");
        });
      }

      const urlModal = document.getElementById("url-modal");
      if (urlModal) {
        urlModal.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-url]");
          if (btn && btn.dataset.url) {
            const input = document.getElementById("target-url-input");
            if (input) input.value = btn.dataset.url;
          }
        });
      }

      const btnCancelLock = document.getElementById("btn-cancel-lock");
      if (btnCancelLock) btnCancelLock.addEventListener("click", () => closeModal("lock-modal"));
      const btnCancelLockAction = document.getElementById("btn-cancel-lock-action");
      if (btnCancelLockAction) btnCancelLockAction.addEventListener("click", () => closeModal("lock-modal"));
      const btnSendLock = document.getElementById("btn-send-lock");
      if (btnSendLock) {
        btnSendLock.addEventListener("click", () => {
          const msgInput = document.getElementById("lock-msg-input");
          const message = msgInput ? msgInput.value.trim() : "";
          sendCommand("all", "lock", { message });
          closeModal("lock-modal");
        });
      }

      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        for (const overlay of document.querySelectorAll(".modal-overlay.active")) {
          if (overlay.id === "vnc-modal") {
            overlay.classList.remove("active");
            document.getElementById("vnc-frame").src = "about:blank";
            document.getElementById("vnc-notice").style.display = "none";
          } else {
            overlay.classList.remove("active");
          }
        }
      });
      for (const overlay of document.querySelectorAll(".modal-overlay")) {
        overlay.addEventListener("click", (e) => {
          if (e.target !== overlay) return;
          if (overlay.id === "vnc-modal") {
            overlay.classList.remove("active");
            document.getElementById("vnc-frame").src = "about:blank";
            document.getElementById("vnc-notice").style.display = "none";
          } else {
            overlay.classList.remove("active");
          }
        });
      }

      pollClients();
      setInterval(pollClients, 3000);
    </script>
  `;
}

// ============================================================================
// 2. BROADCAST PAGE
// ============================================================================

function renderBroadcastPageHtml(tenant?: Tenant, sites: PortalSite[] = [], presets: BroadcastPreset[] = []): string {
  const activeUrl = tenant?.broadcast_url;
  const isBroadcasting = Boolean(activeUrl);

  const presetsHtml = presets
    .map((p) => `
      <div class="preset-item">
        <div>
          <div style="font-weight: 700; font-size: 14px;">${escapeHtml(p.title)}</div>
          <div style="font-size: 12px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace;">${escapeHtml(p.url)}</div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-sm btn-primary btn-launch-preset" data-url="${escapeAttr(p.url)}">Broadcast</button>
          <button type="button" class="btn btn-sm btn-danger btn-delete-preset" data-id="${escapeAttr(p.id)}">Delete</button>
        </div>
      </div>
    `)
    .join("");

  const appShortcutsHtml = sites
    .map((s) => `
      <button type="button" class="btn btn-secondary btn-launch-preset" data-url="${escapeAttr(s.url)}" style="display: inline-flex; align-items: center; gap: 8px; margin: 4px;">
        <span>${escapeHtml(s.icon || "🌐")}</span>
        <span>${escapeHtml(s.title)}</span>
      </button>
    `)
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Lesson Broadcast Center</h1>
        <p class="page-desc">Direct all student workstations simultaneously to a learning resource or live simulation.</p>
      </div>
    </div>

    <div class="grid-2col">
      <div>
        <div class="card">
          <h2 class="card-title">
            <span class="stat-dot ${isBroadcasting ? "dot-green" : "dot-yellow"}"></span>
            ${isBroadcasting ? "Active Lesson Broadcast" : "No Broadcast Active"}
          </h2>
          <p class="card-sub">
            ${
              isBroadcasting
                ? `Workstations are currently synchronized to: <br><code style="font-size: 14px; margin-top: 6px; display: inline-block;">${escapeHtml(activeUrl!)}</code>`
                : "Workstations are displaying their standard Student Learning Portal."
            }
          </p>

          <form id="broadcast-form" style="margin-top: 20px;">
            <div class="form-group">
              <label class="form-label" for="broadcast-url">New Lesson or Resource URL</label>
              <input type="url" class="form-input" id="broadcast-url" required placeholder="https://scratch.mit.edu or https://phet.colorado.edu">
              <div class="form-hint">Workstations navigate instantly via top-level window. External iframes are never used.</div>
            </div>
            <div style="display: flex; gap: 10px;">
              <button type="submit" class="btn btn-primary">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
                Broadcast to All Screens
              </button>
              ${
                isBroadcasting
                  ? `<button type="button" class="btn btn-danger" id="btn-stop-broadcast">Stop Broadcast &amp; Return to Portal</button>`
                  : ""
              }
            </div>
          </form>
        </div>

        <div class="card">
          <h2 class="card-title">1-Click Broadcast from Portal Apps</h2>
          <p class="card-sub">Quickly launch an approved educational app across all student screens.</p>
          <div style="display: flex; flex-wrap: wrap;">
            ${appShortcutsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No portal apps configured yet.</p>`}
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <h2 class="card-title">Custom Lesson Presets &amp; Shortcuts</h2>
          <p class="card-sub">Saved bookmarks for recurring classroom activities and exams.</p>

          <form id="add-preset-form" style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border);">
            <div class="form-group">
              <label class="form-label" for="preset-title">Shortcut Name</label>
              <input type="text" class="form-input" id="preset-title" required placeholder="e.g. Class 10 Python Practical">
            </div>
            <div class="form-group">
              <label class="form-label" for="preset-url">Target URL</label>
              <input type="url" class="form-input" id="preset-url" required placeholder="https://replit.com/@classroom/demo">
            </div>
            <button type="submit" class="btn btn-secondary">Save Shortcut</button>
          </form>

          <div id="presets-list">
            ${presetsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No custom shortcuts saved yet.</p>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderBroadcastScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      document.getElementById("broadcast-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const url = document.getElementById("broadcast-url").value.trim();
        if (!url) return;
        try {
          const res = await fetch(labkioskApi("/api/command"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: "all", action: "navigate", url })
          });
          const data = await res.json();
          if (data.status === "ok") {
            window.location.reload();
          } else {
            alert(data.error || "Broadcast failed");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      const stopBtn = document.getElementById("btn-stop-broadcast");
      if (stopBtn) {
        stopBtn.addEventListener("click", async () => {
          try {
            const res = await fetch(labkioskApi("/api/command"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target: "all", action: "navigate", resetPortal: true })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              alert(data.error || "Failed to stop broadcast");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      }

      document.getElementById("add-preset-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const title = document.getElementById("preset-title").value.trim();
        const url = document.getElementById("preset-url").value.trim();
        if (!title || !url) return;
        try {
          const res = await fetch(labkioskApi("/api/broadcast-presets"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, url })
          });
          const data = await res.json();
          if (data.preset) {
            window.location.reload();
          } else {
            alert(data.error || "Failed to save preset");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      document.querySelectorAll(".btn-launch-preset").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const url = btn.dataset.url;
          if (!url) return;
          try {
            const res = await fetch(labkioskApi("/api/command"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target: "all", action: "navigate", url })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              alert(data.error || "Broadcast failed");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-delete-preset").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!id || !confirm("Delete this shortcut?")) return;
          try {
            const res = await fetch(labkioskApi("/api/broadcast-presets/" + encodeURIComponent(id)), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              alert(data.error || "Failed to delete preset");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });
    </script>
  `;
}

// ============================================================================
// 3. PORTAL PAGE
// ============================================================================

function renderPortalPageHtml(_tenant?: Tenant, sites: PortalSite[] = []): string {
  const cardsHtml = sites
    .map((s) => `
      <div class="card" style="display: flex; flex-direction: column; justify-content: space-between; gap: 12px; padding: 18px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">${escapeHtml(s.icon || "🌐")}</span>
          <div>
            <div style="font-weight: 700; font-size: 15px;">${escapeHtml(s.title)}</div>
            <div style="font-size: 12px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace;">${escapeHtml(s.domain)}</div>
          </div>
        </div>
        <div style="font-size: 12px; color: #93c5fd; background: rgba(59, 130, 246, 0.1); padding: 4px 8px; border-radius: 6px; align-self: flex-start;">
          ${escapeHtml(s.category)}
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 12px; margin-top: 4px;">
          <a href="${escapeAttr(safeHttpUrl(s.url) || "#")}" target="_blank" rel="noopener noreferrer" style="font-size: 12px; color: var(--accent); text-decoration: none;">Test Link &rarr;</a>
          <button type="button" class="btn btn-sm btn-danger btn-delete-app" data-id="${escapeAttr(s.id)}">Remove</button>
        </div>
      </div>
    `)
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Student Learning Portal Manager</h1>
        <p class="page-desc">Configure the application cards students see when logging into thin client workstations.</p>
      </div>
      <div>
        <a href="/portal" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">
          Preview Student Portal &rarr;
        </a>
      </div>
    </div>

    <div class="grid-2col">
      <div>
        <div class="card">
          <h2 class="card-title">Add Educational Application</h2>
          <p class="card-sub">Applications are automatically permitted through the kiosk domain filter.</p>

          <form id="add-app-form">
            <div class="form-group">
              <label class="form-label" for="app-title">Application Title</label>
              <input type="text" class="form-input" id="app-title" required placeholder="e.g. Scratch Creative Coding">
            </div>
            <div class="form-group">
              <label class="form-label" for="app-url">Destination URL</label>
              <input type="url" class="form-input" id="app-url" required placeholder="https://scratch.mit.edu">
            </div>
            <div class="grid-2col" style="gap: 12px; margin-bottom: 0;">
              <div class="form-group">
                <label class="form-label" for="app-category">Subject / Category</label>
                <input type="text" class="form-input" id="app-category" placeholder="e.g. Computer Science">
              </div>
              <div class="form-group">
                <label class="form-label" for="app-icon">Icon Emoji</label>
                <input type="text" class="form-input" id="app-icon" placeholder="e.g. 🐱 or 🔬" maxlength="4">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="app-thumb">Thumbnail Image URL (Optional)</label>
              <input type="url" class="form-input" id="app-thumb" placeholder="https://images.unsplash.com/photo-...">
            </div>
            <button type="submit" class="btn btn-primary">Add to Student Portal</button>
          </form>
        </div>
      </div>

      <div>
        <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 16px;">Active Portal Cards (${sites.length})</h2>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px;">
          ${cardsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No applications added yet.</p>`}
        </div>
      </div>
    </div>
  `;
}

function renderPortalScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      document.getElementById("add-app-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const title = document.getElementById("app-title").value.trim();
        const url = document.getElementById("app-url").value.trim();
        const category = document.getElementById("app-category").value.trim() || "General";
        const icon = document.getElementById("app-icon").value.trim() || "🌐";
        const thumbnailUrl = document.getElementById("app-thumb").value.trim() || undefined;

        if (!title || !url) return;
        try {
          const res = await fetch(labkioskApi("/api/portal-sites"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, url, category, icon, thumbnailUrl })
          });
          const data = await res.json();
          if (data.site) {
            window.location.reload();
          } else {
            alert(data.error || "Failed to add application");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      document.querySelectorAll(".btn-delete-app").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!id || !confirm("Remove this application from the student portal?")) return;
          try {
            const res = await fetch(labkioskApi("/api/portal-sites/" + encodeURIComponent(id)), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              alert(data.error || "Failed to remove application");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });
    </script>
  `;
}

// ============================================================================
// 4. WHITELIST PAGE
// ============================================================================

function renderWhitelistPageHtml(domains: string[] = []): string {
  const domainTagsHtml = domains
    .map((d) => `
      <span class="domain-tag">
        <span>${escapeHtml(d)}</span>
        <button type="button" class="btn-remove-domain" data-domain="${escapeAttr(d)}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 0 2px;">✕</button>
      </span>
    `)
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Domain Allowlist &amp; Content Security</h1>
        <p class="page-desc">Define the educational web domains student thin clients are permitted to access.</p>
      </div>
    </div>

    <div class="grid-2col">
      <div>
        <div class="card">
          <h2 class="card-title">Add Allowed Domain</h2>
          <p class="card-sub">Student Chromium browsers enforce this policy at the OS layer.</p>

          <form id="add-domain-form" style="margin-bottom: 24px;">
            <div class="form-group">
              <label class="form-label" for="domain-input">Domain Name</label>
              <input type="text" class="form-input" id="domain-input" required placeholder="e.g. scratch.mit.edu">
              <div class="form-hint">Enter the bare domain without http:// or trailing slashes.</div>
            </div>
            <button type="submit" class="btn btn-primary">Add to Allowlist</button>
          </form>

          <h3 style="font-size: 14px; font-weight: 700; margin-bottom: 12px;">Quick-Add Educational Preset Packs</h3>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary btn-sm btn-pack" data-domains="khanacademy.org,kastatic.org,kasandbox.org">Khan Academy Pack</button>
            <button type="button" class="btn btn-secondary btn-sm btn-pack" data-domains="scratch.mit.edu,replit.com,github.com">Coding &amp; STEM Pack</button>
            <button type="button" class="btn btn-secondary btn-sm btn-pack" data-domains="cbse.gov.in,ncert.nic.in,diksha.gov.in">CBSE / NCERT Pack</button>
            <button type="button" class="btn btn-secondary btn-sm btn-pack" data-domains="wikipedia.org,wikimedia.org">Encyclopedia Pack</button>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h2 class="card-title" style="margin-bottom: 0;">Currently Allowed Domains (${domains.length})</h2>
            <input type="text" id="filter-domains" placeholder="Search domains..." style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 12px; color: #fff;">
          </div>
          <div id="domains-container" style="display: flex; flex-wrap: wrap; gap: 8px; max-height: 480px; overflow-y: auto;">
            ${domainTagsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No domains configured.</p>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderWhitelistScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      document.getElementById("add-domain-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const domain = document.getElementById("domain-input").value.trim();
        if (!domain) return;
        try {
          const res = await fetch(labkioskApi("/api/whitelist"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "add", domain })
          });
          const data = await res.json();
          if (data.status === "ok") {
            window.location.reload();
          } else {
            alert(data.error || "Failed to add domain");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      document.querySelectorAll(".btn-remove-domain").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const domain = btn.dataset.domain;
          if (!domain || !confirm("Remove " + domain + " from the allowlist?")) return;
          try {
            const res = await fetch(labkioskApi("/api/whitelist"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "remove", domain })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              alert(data.error || "Failed to remove domain");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-pack").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const raw = btn.dataset.domains || "";
          const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
          for (const d of list) {
            await fetch(labkioskApi("/api/whitelist"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "add", domain: d })
            });
          }
          window.location.reload();
        });
      });

      document.getElementById("filter-domains").addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase().trim();
        document.querySelectorAll(".domain-tag").forEach((tag) => {
          tag.style.display = tag.textContent.toLowerCase().includes(q) ? "inline-flex" : "none";
        });
      });
    </script>
  `;
}

// ============================================================================
// 5. TEACHERS & STAFF PAGE
// ============================================================================

function renderTeachersPageHtml(teachers: TenantUser[] = []): string {
  const rowsHtml = teachers
    .map((t) => {
      const permsList = (t.permissions || []).map((p) => `<span class="badge badge-blue" style="font-size: 10px; margin-right: 4px;">${escapeHtml(p)}</span>`).join("");
      return `
        <tr>
          <td>
            <strong>${escapeHtml(t.name || "Teacher")}</strong>
            <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.email || "")}</div>
          </td>
          <td>
            <span class="badge badge-green">${escapeHtml(t.role)}</span>
          </td>
          <td>
            ${permsList || `<span style="color: var(--text-muted); font-size: 12px;">Full Lab Access</span>`}
          </td>
          <td>
            <button type="button" class="btn btn-sm btn-danger btn-delete-teacher" data-id="${escapeAttr(t.id)}">Remove</button>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Teachers &amp; Sub-Admin Delegation</h1>
        <p class="page-desc">Delegate classroom monitoring, broadcasting, and allowlist controls to individual instructors.</p>
      </div>
    </div>

    <div class="grid-2col">
      <div>
        <div class="card">
          <h2 class="card-title">Invite / Create Teacher Account</h2>
          <p class="card-sub">Instructors can log in directly to manage classroom sessions.</p>

          <form id="add-teacher-form">
            <div class="form-group">
              <label class="form-label" for="teacher-name">Full Name</label>
              <input type="text" class="form-input" id="teacher-name" required placeholder="e.g. Sarah Jenkins">
            </div>
            <div class="form-group">
              <label class="form-label" for="teacher-email">Email Address</label>
              <input type="email" class="form-input" id="teacher-email" required placeholder="sjenkins@school.edu">
            </div>
            <div class="form-group">
              <label class="form-label" for="teacher-password">Temporary Password</label>
              <input type="text" class="form-input" id="teacher-password" required value="TeacherPass2026!">
            </div>
            <div class="form-group">
              <label class="form-label" for="teacher-role">Role</label>
              <select class="form-select" id="teacher-role">
                <option value="teacher">Teacher (Classroom Instructor)</option>
                <option value="lab_assistant">Lab Assistant (Monitoring Only)</option>
                <option value="content_manager">Content Manager (Portal &amp; Whitelist)</option>
                <option value="school_admin">Co-Administrator (Full Access)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Delegated Permissions</label>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                <label style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
                  <input type="checkbox" name="perms" value="workstations" checked> Workstations (Monitor &amp; Lock PCs)
                </label>
                <label style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
                  <input type="checkbox" name="perms" value="broadcast" checked> Broadcast (Broadcast Lessons)
                </label>
                <label style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
                  <input type="checkbox" name="perms" value="portal" checked> Student Portal (Manage Cards)
                </label>
                <label style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
                  <input type="checkbox" name="perms" value="whitelist"> Allowlist (Manage Educational Domains)
                </label>
                <label style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
                  <input type="checkbox" name="perms" value="settings"> Lab Settings (Profile &amp; Keys)
                </label>
              </div>
            </div>

            <button type="submit" class="btn btn-primary">Create Teacher Account</button>
          </form>
        </div>
      </div>

      <div>
        <div class="card" style="padding: 0; overflow: hidden;">
          <div style="padding: 20px 24px; border-bottom: 1px solid var(--border);">
            <h2 class="card-title" style="margin-bottom: 0;">Authorized Lab Instructors (${teachers.length})</h2>
          </div>
          <div class="table-container" style="border: none; border-radius: 0;">
            <table>
              <thead>
                <tr>
                  <th>Teacher</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml || `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 32px;">No sub-admins or teachers added yet.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTeachersScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      document.getElementById("add-teacher-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("teacher-name").value.trim();
        const email = document.getElementById("teacher-email").value.trim();
        const password = document.getElementById("teacher-password").value;
        const role = document.getElementById("teacher-role").value;
        const perms = Array.from(document.querySelectorAll('input[name="perms"]:checked')).map((c) => c.value);

        try {
          const res = await fetch(labkioskApi("/api/tenant/teachers"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, password, role, permissions: perms })
          });
          const data = await res.json();
          if (data.status === "ok") {
            window.location.reload();
          } else {
            alert(data.error || "Failed to create teacher account");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      document.querySelectorAll(".btn-delete-teacher").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!id || !confirm("Remove this teacher from the lab?")) return;
          try {
            const res = await fetch(labkioskApi("/api/tenant/teachers/" + encodeURIComponent(id)), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              alert(data.error || "Failed to remove teacher");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });
    </script>
  `;
}

// ============================================================================
// 6. SETTINGS PAGE (ZERO CRAMPED POPUPS!)
// ============================================================================

function renderSettingsPageHtml(tenant?: Tenant, config?: LabConfig, baseDomain = "labkiosk.akbhoi.com"): string {
  const currentSubdomain = tenant?.subdomain || "";
  const customDomain = tenant?.custom_domain || "";
  const customDomainStatus = tenant?.custom_domain_status || "none";
  const homeRoute = tenant?.home_route || "/home";
  const tunnelDomain = tenant?.tunnel_domain || config?.tunnelDomain || "";

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Lab Settings &amp; Configuration</h1>
        <p class="page-desc">Manage institution profile, subdomain customization, custom domain, VNC tunnel, and enrollment keys.</p>
      </div>
    </div>

    <div class="grid-2col">
      <!-- Card 1: Lab Profile & Kiosk Mode -->
      <div class="card" id="section-general">
        <h2 class="card-title">Institution &amp; Kiosk Profile</h2>
        <p class="card-sub">General settings for this computer lab environment.</p>

        <form id="form-profile-settings">
          <div class="form-group">
            <label class="form-label" for="setting-school-name">School / Lab Name</label>
            <input type="text" class="form-input" id="setting-school-name" value="${escapeAttr(tenant?.name || "")}" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="setting-kiosk-mode">Kiosk Display Mode</label>
            <select class="form-select" id="setting-kiosk-mode">
              <option value="portal" ${tenant?.mode === "portal" ? "selected" : ""}>Student Educational Portal (Card Grid)</option>
              <option value="single_url" ${tenant?.mode === "single_url" ? "selected" : ""}>Direct Single-Site Lockdown</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="setting-default-url">Direct Lockdown URL (for Single-Site Mode)</label>
            <input type="url" class="form-input" id="setting-default-url" value="${escapeAttr(tenant?.default_url || "https://www.khanacademy.org")}">
          </div>
          <div class="form-group">
            <label class="form-label" for="setting-lock-msg">Default Lock Screen Message</label>
            <input type="text" class="form-input" id="setting-lock-msg" value="${escapeAttr(tenant?.default_lock_message || "Screens locked by the instructor. Please look to the front.")}">
          </div>
          <button type="submit" class="btn btn-primary">Save Profile Settings</button>
        </form>
      </div>

      <!-- Card 2: Subdomain Customization -->
      <div class="card" id="section-subdomain">
        <h2 class="card-title">School Subdomain Customization</h2>
        <p class="card-sub">Customize your school's unique address on <code>${escapeHtml(baseDomain)}</code>.</p>

        <form id="form-subdomain-settings">
          <div class="form-group">
            <label class="form-label" for="setting-subdomain">Subdomain Slug</label>
            <div class="form-row">
              <input type="text" class="form-input" id="setting-subdomain" value="${escapeAttr(currentSubdomain)}" required pattern="[a-zA-Z0-9-]{3,63}">
              <span style="font-size: 14px; color: var(--text-muted); white-space: nowrap; padding-bottom: 10px;">.${escapeHtml(baseDomain)}</span>
            </div>
            <div class="form-hint" style="color: #fde68a;">Notice: Changing your subdomain takes effect immediately. Previously enrolled thin clients will need to be updated with the new address.</div>
          </div>
          <button type="submit" class="btn btn-secondary">Update Subdomain</button>
        </form>
      </div>

      <!-- Card 3: Custom Domain -->
      <div class="card" id="section-custom-domain">
        <h2 class="card-title">White-Label Custom Domain</h2>
        <p class="card-sub">Point your own institutional domain (e.g. <code>kiosk.myschool.edu</code>) to this lab.</p>

        ${
          customDomain && customDomainStatus === "approved"
            ? `
            <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 14px 18px; margin-bottom: 16px;">
              <span class="badge badge-green">ACTIVE DOMAIN</span>
              <div style="font-size: 16px; font-weight: 700; color: #6ee7b7; margin-top: 6px; font-family: 'JetBrains Mono', monospace;">https://${escapeHtml(customDomain)}</div>
            </div>
            <button type="button" class="btn btn-danger" id="btn-disconnect-custom">Disconnect Custom Domain</button>
          `
            : customDomainStatus === "pending"
            ? `
            <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 14px 18px; margin-bottom: 16px;">
              <span class="badge badge-yellow">PENDING SUPER ADMIN APPROVAL</span>
              <div style="font-size: 15px; font-weight: 700; color: #fde68a; margin-top: 6px;">${escapeHtml(tenant?.requested_custom_domain || "")}</div>
            </div>
            <button type="button" class="btn btn-secondary" id="btn-cancel-custom">Cancel Request</button>
          `
            : `
            <form id="form-custom-domain">
              <div class="form-group">
                <label class="form-label" for="setting-custom-domain">Domain Name</label>
                <input type="text" class="form-input" id="setting-custom-domain" placeholder="e.g. lab.myschool.edu" required>
                <div class="form-hint">Create a CNAME record in your DNS pointing to <code>${escapeHtml(baseDomain)}</code>, then submit below.</div>
              </div>
              <button type="submit" class="btn btn-secondary">Request Custom Domain</button>
            </form>
          `
        }
      </div>

      <!-- Card 4: Kiosk Routing & Home Page -->
      <div class="card" id="section-routing">
        <h2 class="card-title">Kiosk Routing &amp; Home URL</h2>
        <p class="card-sub">Choose where workstations navigate upon boot and when resetting.</p>

        <form id="form-routing-settings">
          <div class="form-group">
            <label class="form-label" for="setting-home-route">Default Landing Path</label>
            <select class="form-select" id="setting-home-route">
              <option value="/home" ${homeRoute === "/home" ? "selected" : ""}>/home (Dedicated Student Portal)</option>
              <option value="/" ${homeRoute === "/" ? "selected" : ""}>/ (Subdomain Apex)</option>
              <option value="/portal" ${homeRoute === "/portal" ? "selected" : ""}>/portal (Portal Direct)</option>
            </select>
            <div class="form-hint">Workstations will open this route automatically when starting up.</div>
          </div>
          <button type="submit" class="btn btn-secondary">Save Routing</button>
        </form>
      </div>

      <!-- Card 5: VNC & Remote Control Tunnel -->
      <div class="card" id="section-vnc">
        <h2 class="card-title">Remote Control &amp; VNC Tunnel</h2>
        <p class="card-sub">Cloudflare Tunnel hostname for live classroom screen control.</p>

        <form id="form-tunnel-settings">
          <div class="form-group">
            <label class="form-label" for="setting-tunnel-domain">Tunnel Domain</label>
            <input type="text" class="form-input" id="setting-tunnel-domain" value="${escapeAttr(tunnelDomain)}" placeholder="e.g. lab.myschool.edu or demo.labkiosk.akbhoi.com">
            <div class="form-hint">Thin clients forward loopback noVNC port 6080 to this tunnel egress domain.</div>
          </div>
          <button type="submit" class="btn btn-secondary">Update Tunnel Domain</button>
        </form>
      </div>

      <!-- Card 6: Workstation Enrollment Key -->
      <div class="card" id="section-enrollment">
        <h2 class="card-title">Workstation Enrollment Key</h2>
        <p class="card-sub">Secret key used to securely pair thin clients to this school.</p>

        <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between;">
          <code id="enrollment-key-display" style="font-size: 16px; font-weight: 700; color: #93c5fd; letter-spacing: 1px;">••••••••••••</code>
          <button type="button" class="btn btn-sm btn-secondary" id="btn-reveal-key">Reveal Key</button>
        </div>
        <button type="button" class="btn btn-danger btn-sm" id="btn-rotate-key">Rotate Enrollment Key</button>
      </div>

      <!-- Card 7: Account Security -->
      <div class="card" id="section-password">
        <h2 class="card-title">Account Security &amp; Password</h2>
        <p class="card-sub">Change the password for this administrative account.</p>

        <form id="form-change-password">
          <div class="form-group">
            <label class="form-label" for="pwd-current">Current Password</label>
            <input type="password" class="form-input" id="pwd-current" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="pwd-new">New Password (min 12 characters)</label>
            <input type="password" class="form-input" id="pwd-new" required minlength="12">
          </div>
          <button type="submit" class="btn btn-secondary">Change Password</button>
        </form>
      </div>
    </div>
  `;
}

function renderSettingsScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      document.getElementById("form-profile-settings").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("setting-school-name").value.trim();
        const mode = document.getElementById("setting-kiosk-mode").value;
        const defaultUrl = document.getElementById("setting-default-url").value.trim();
        const defaultLockMessage = document.getElementById("setting-lock-msg").value.trim();

        try {
          const res = await fetch(labkioskApi("/api/tenant/settings"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, mode, defaultUrl, defaultLockMessage })
          });
          const data = await res.json();
          if (data.status === "ok") {
            alert("Profile settings saved successfully.");
            window.location.reload();
          } else {
            alert(data.error || "Failed to save settings");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      document.getElementById("form-subdomain-settings").addEventListener("submit", async (e) => {
        e.preventDefault();
        const subdomain = document.getElementById("setting-subdomain").value.trim().toLowerCase();
        if (!confirm("Update subdomain to '" + subdomain + "'? Workstations will need their configuration updated.")) return;

        try {
          const res = await fetch(labkioskApi("/api/tenant/subdomain"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subdomain })
          });
          const data = await res.json();
          if (data.status === "ok") {
            alert("Subdomain updated successfully! Redirecting to new console URL...");
            window.location.href = data.redirectUrl || "/admin";
          } else {
            alert(data.error || "Failed to update subdomain");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      const customForm = document.getElementById("form-custom-domain");
      if (customForm) {
        customForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const domain = document.getElementById("setting-custom-domain").value.trim();
          try {
            const res = await fetch(labkioskApi("/api/settings/custom-domain"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ domain })
            });
            const data = await res.json();
            if (data.status === "ok") {
              alert("Custom domain request submitted for Super Admin review.");
              window.location.reload();
            } else {
              alert(data.error || "Failed to submit custom domain");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      }

      const disconnectBtn = document.getElementById("btn-disconnect-custom");
      if (disconnectBtn) {
        disconnectBtn.addEventListener("click", async () => {
          if (!confirm("Disconnect your custom domain?")) return;
          try {
            const res = await fetch(labkioskApi("/api/settings/custom-domain"), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              alert(data.error || "Failed to disconnect domain");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      }

      const cancelCustomBtn = document.getElementById("btn-cancel-custom");
      if (cancelCustomBtn) {
        cancelCustomBtn.addEventListener("click", async () => {
          try {
            await fetch(labkioskApi("/api/settings/custom-domain"), { method: "DELETE" });
            window.location.reload();
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      }

      document.getElementById("form-routing-settings").addEventListener("submit", async (e) => {
        e.preventDefault();
        const homeRoute = document.getElementById("setting-home-route").value;
        try {
          const res = await fetch(labkioskApi("/api/tenant/settings"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ homeRoute })
          });
          const data = await res.json();
          if (data.status === "ok") {
            alert("Routing saved.");
          } else {
            alert(data.error || "Failed to save routing");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      document.getElementById("form-tunnel-settings").addEventListener("submit", async (e) => {
        e.preventDefault();
        const tunnelDomain = document.getElementById("setting-tunnel-domain").value.trim();
        try {
          const res = await fetch(labkioskApi("/api/tenant/settings"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tunnelDomain })
          });
          const data = await res.json();
          if (data.status === "ok") {
            alert("Tunnel domain updated.");
          } else {
            alert(data.error || "Failed to update tunnel");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      let keyRevealed = false;
      document.getElementById("btn-reveal-key").addEventListener("click", async () => {
        const display = document.getElementById("enrollment-key-display");
        const btn = document.getElementById("btn-reveal-key");
        if (!keyRevealed) {
          try {
            const res = await fetch(labkioskApi("/api/settings/enrollment-key"));
            const data = await res.json();
            display.textContent = data.enrollmentKey;
            btn.textContent = "Copy Key";
            keyRevealed = true;
          } catch (err) {
            alert("Failed to fetch key");
          }
        } else {
          navigator.clipboard.writeText(display.textContent);
          alert("Enrollment key copied to clipboard!");
        }
      });

      document.getElementById("btn-rotate-key").addEventListener("click", async () => {
        if (!confirm("Rotate enrollment key? Previously enrolled devices will continue functioning, but newly enrolled machines will require the fresh key.")) return;
        try {
          const res = await fetch(labkioskApi("/api/settings/enrollment-key"), { method: "POST" });
          const data = await res.json();
          if (data.status === "ok") {
            document.getElementById("enrollment-key-display").textContent = data.enrollmentKey;
            alert("Enrollment key rotated: " + data.enrollmentKey);
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });

      document.getElementById("form-change-password").addEventListener("submit", async (e) => {
        e.preventDefault();
        const currentPassword = document.getElementById("pwd-current").value;
        const newPassword = document.getElementById("pwd-new").value;
        try {
          const res = await fetch(labkioskApi("/api/auth/change-password"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword, newPassword })
          });
          const data = await res.json();
          if (data.status === "ok") {
            alert("Password updated successfully.");
            document.getElementById("form-change-password").reset();
          } else {
            alert(data.error || "Failed to change password");
          }
        } catch (err) {
          alert("Network error: " + err.message);
        }
      });
    </script>
  `;
}
