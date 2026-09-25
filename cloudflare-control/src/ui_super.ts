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
  activeTab?: "organizations" | "approvals" | "catalogs" | "system";
  nonce: string;
}

export function renderSuperAdminHtml(data: SuperAdminOptions): string {
  const { superAdminEmail, superAdminId, tenants, baseDomain = "labkiosk.akbhoi.com", activeTab = "organizations", nonce } = data;

  const pendingList = tenants.filter((t) => t.status === "pending" || t.requested_subdomain);
  const pendingCustomList = tenants.filter((t) => t.custom_domain_status === "pending" && t.requested_custom_domain);
  const totalClients = tenants.reduce((acc, t) => acc + (t.total_clients || 0), 0);
  const totalOnline = tenants.reduce((acc, t) => acc + (t.online_clients || 0), 0);
  const pendingCount = pendingList.length + pendingCustomList.length;

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
    <tr>
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
      label: "Organizations Directory",
      href: "/super/organizations",
      badge: tenants.length,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`
    },
    {
      id: "approvals",
      label: "Approvals Queue",
      href: "/super/approvals",
      badge: pendingCount > 0 ? pendingCount : undefined,
      badgeTone: "attention",
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`
    },
    {
      id: "catalogs",
      label: "Translation Catalogs",
      href: "/super/catalogs",
      badge: catalogList.length,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`
    },
    {
      id: "system",
      label: "System Health & Logs",
      href: "/super/system",
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`
    }
  ];

  const stats: StatItem[] = [
    { label: "Organizations", value: tenants.length, color: "blue" },
    { label: "Online", value: `${totalOnline} / ${totalClients}`, color: "green" },
    { label: "Approvals", value: pendingCount, color: pendingCount > 0 ? "yellow" : "blue" }
  ];

  const activeTenantsCount = tenants.filter((t) => t.status === "active").length;
  const suspendedTenantsCount = tenants.filter((t) => t.status === "suspended").length;

  let subPanelTitle = "Platform Governance";
  let subPanelSubtitle = "Global tenant administration";
  let subPanelHtml = "";

  if (activeTab === "organizations") {
    subPanelTitle = "Organizations Directory";
    subPanelSubtitle = "Tenant overview & filters";
    subPanelHtml = `
      <div class="sub-section-title">Directory Overview</div>
      <div class="kv-list">
        <div class="kv-row"><span>Organizations</span><strong>${tenants.length}</strong></div>
        <div class="kv-row"><span>Active</span><strong>${activeTenantsCount}</strong></div>
        <div class="kv-row"><span>Suspended</span><strong>${suspendedTenantsCount}</strong></div>
        <div class="kv-row"><span>Workstations online</span><strong>${totalOnline} / ${totalClients}</strong></div>
      </div>

      <div class="sub-section-title">Privacy Invariant</div>
      <div class="panel-note">
        Super Admins cannot access any organization's internal console or telemetry except the platform's demo organizations. Organization data isolation is enforced at the edge D1 layer.
      </div>
    `;
  } else if (activeTab === "approvals") {
    subPanelTitle = "Approvals Queue";
    subPanelSubtitle = "Domain review & routing";
    subPanelHtml = `
      <div class="sub-section-title">Queue Status</div>
      <div class="kv-list">
        <div class="kv-row"><span>Subdomains pending</span><span class="badge ${pendingList.length > 0 ? "badge-yellow" : "badge-neutral"}">${pendingList.length}</span></div>
        <div class="kv-row"><span>Custom domains pending</span><span class="badge ${pendingCustomList.length > 0 ? "badge-yellow" : "badge-neutral"}">${pendingCustomList.length}</span></div>
      </div>

      <div class="sub-section-title">Approval Policy</div>
      <div class="panel-note">
        Approved subdomains immediately bind in edge routing. Custom domains require DNS CNAME records pointing to <code>${escapeHtml(baseDomain)}</code>.
      </div>
    `;
  } else if (activeTab === "catalogs") {
    subPanelTitle = "Translation Catalogs";
    subPanelSubtitle = "Language & localization";
    subPanelHtml = `
      <div class="sub-section-title">Catalogs Overview</div>
      <div class="kv-list">
        <div class="kv-row"><span>Installed languages</span><strong>${catalogList.length}</strong></div>
        <div class="kv-row"><span>Default language</span><strong>English (en-US)</strong></div>
      </div>

      <div class="sub-section-title">Standard Locale Tags</div>
      <div class="panel-note">
        Catalogs follow BCP 47 language tags (e.g. <code>hi-IN</code>, <code>fr-FR</code>, <code>de-DE</code>, <code>es-ES</code>, <code>ar-SA</code>). Kiosk clients fetch translations dynamically at boot.
      </div>
    `;
  } else {
    subPanelTitle = "System Health";
    subPanelSubtitle = "Diagnostics & audit logs";
    subPanelHtml = `
      <div class="sub-section-title">Quick Jump</div>
      <div class="sub-action-list">
        <a href="#platform-architecture" class="sub-action-item">
          <span>Platform Architecture</span>
        </a>
        <a href="#platform-audit" class="sub-action-item">
          <span>Platform Audit Logs</span>
        </a>
      </div>

      <div class="sub-section-title">Edge Security</div>
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
            <tbody>
              ${allRows}
            </tbody>
          </table>
        </div>
      </div>
  `;

  const approvalsPaneHtml = `
      <div class="card">
        <h2 class="card-title">Pending Subdomain Requests (${pendingList.length})</h2>
        <p class="card-sub">Organizations requesting initial activation or subdomain modifications.</p>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Contact</th>
                <th>Requested Subdomain</th>
                <th>Registered Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pendingSubdomainRows || `<tr><td colspan="5" class="table-empty">No pending subdomain requests.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

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

  const catalogsPaneHtml = `
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

      <div class="card">
        <h2 class="card-title">Workstation Interface Catalogs (i18n)</h2>
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

  const systemPaneHtml = `
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
${auditCardHtml}
  `;

  const panesByTab: Record<typeof activeTab, string> = {
    organizations: organizationsPaneHtml,
    approvals: approvalsPaneHtml,
    catalogs: catalogsPaneHtml,
    system: systemPaneHtml
  };

  const contentHtml = `${bannerHtml}
${panesByTab[activeTab] || organizationsPaneHtml}`;

  const scriptsHtml = `
    <script nonce="${escapeAttr(nonce)}">
      document.querySelectorAll(".btn-approve-sub").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const subdomain = btn.dataset.subdomain;
          const agreed = await lkConfirm({
            title: "Approve '" + subdomain + "'?",
            message: "The console and user portal for this organization go live on that address straight away, and its workstations can enrol against it.",
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
            title: "Reject this request?",
            message: "The organization stays pending and cannot enrol workstations. Nothing is deleted, so you can approve it later.",
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
