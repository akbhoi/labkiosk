/**
 * Super Admin Master Console UI
 * Platform owner interface for managing schools, approving subdomains, and global analytics.
 * Strictly enforces privacy: Super admin cannot access school consoles except demo.
 */

import { Tenant } from "./types";
import { escapeHtml, escapeAttr } from "./escape";
import { renderLayoutHtml, NavItem, StatItem } from "./ui_layout";

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
  tenants: SuperConsoleTenant[];
  catalogs?: SuperConsoleCatalog[];
  baseDomain?: string;
  activeTab?: "schools" | "approvals" | "catalogs" | "system";
  nonce: string;
}

export function renderSuperAdminHtml(data: SuperAdminOptions): string {
  const { superAdminEmail, tenants, baseDomain = "labkiosk.akbhoi.com", activeTab = "schools", nonce } = data;

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
      <td><strong>${escapeHtml(c.tag)}</strong></td>
      <td>${escapeHtml(c.name)}</td>
      <td><span class="badge badge-blue">${escapeHtml(c.direction.toUpperCase())}</span></td>
      <td>${Number(c.entry_count) || 0}</td>
      <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px;">${
        c.updated_at && Number.isFinite(c.updated_at)
          ? escapeHtml(new Date(c.updated_at * 1000).toISOString().slice(0, 16).replace("T", " "))
          : "-"
      }</td>
      <td>
        <button class="btn btn-sm btn-danger btn-delete-catalog" data-tag="${escapeAttr(c.tag)}">Delete</button>
      </td>
    </tr>
  `
    )
    .join("");

  const pendingSubdomainRows = pendingList
    .map(
      (t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.admin_name)} <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.admin_email)}</div></td>
      <td>
        <span class="badge badge-yellow">
          ${
            t.requested_subdomain
              ? `<b>${escapeHtml(t.requested_subdomain)}</b> (was ${escapeHtml(t.subdomain)})`
              : `<b>${escapeHtml(t.subdomain)}</b>`
          }
        </span>
      </td>
      <td>${escapeHtml(new Date(t.created_at * 1000).toISOString().slice(0, 10))}</td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-sm btn-success btn-approve-sub" data-tenant="${escapeHtml(t.id)}" data-subdomain="${escapeHtml(t.requested_subdomain || t.subdomain)}">Approve</button>
          <button class="btn btn-sm btn-secondary btn-edit-sub" data-tenant="${escapeHtml(t.id)}">Assign Custom</button>
          <button class="btn btn-sm btn-danger btn-reject-sub" data-tenant="${escapeHtml(t.id)}">Reject</button>
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
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.admin_name)} <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.admin_email)}</div></td>
      <td>
        <span class="badge badge-yellow" style="font-family: 'JetBrains Mono', monospace;">
          ${escapeHtml(t.requested_custom_domain || "")}
        </span>
      </td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-sm btn-success btn-approve-custom" data-tenant="${escapeHtml(t.id)}" data-domain="${escapeAttr(t.requested_custom_domain || "")}">Approve Domain</button>
          <button class="btn btn-sm btn-danger btn-reject-custom" data-tenant="${escapeHtml(t.id)}">Reject</button>
        </div>
      </td>
    </tr>
  `
    )
    .join("");

  const allRows = tenants
    .map((t) => {
      const isDemo = t.subdomain === "demo";
      const href = `/admin?tenant=${encodeURIComponent(t.subdomain)}`;
      return `
    <tr>
      <td>
        <strong>${escapeHtml(t.name)}</strong>
        ${isDemo ? `<span class="badge badge-blue" style="margin-left: 6px;">DEMO TENANT</span>` : ""}
      </td>
      <td>${escapeHtml(t.admin_name)} <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.admin_email)}</div></td>
      <td>
        <span style="font-family: 'JetBrains Mono', monospace; font-size: 13px;">${escapeHtml(t.subdomain)}.${escapeHtml(baseDomain)}</span>
      </td>
      <td>
        ${
          t.custom_domain
            ? `<span class="badge badge-green">ACTIVE</span> <span style="color: #6ee7b7; font-family: 'JetBrains Mono', monospace; font-size: 12px; margin-left: 6px;">${escapeHtml(t.custom_domain)}</span>`
            : t.custom_domain_status === "pending"
              ? `<span class="badge badge-yellow">PENDING</span> <span style="font-family: 'JetBrains Mono', monospace; font-size: 12px; margin-left: 6px; color: #fbbf24;">${escapeHtml(t.requested_custom_domain || "")}</span>`
              : `<span style="color: var(--text-muted);">&mdash;</span>`
        }
      </td>
      <td>
        <span class="badge ${t.status === "active" ? "badge-green" : t.status === "suspended" ? "badge-red" : "badge-yellow"}">${escapeHtml(String(t.status).toUpperCase())}</span>
      </td>
      <td>
        <span style="font-weight: 700;">
          <span class="stat-dot ${t.online_clients > 0 ? "dot-green" : "dot-red"}"></span>
          ${Number(t.online_clients) || 0} / ${Number(t.total_clients) || 0}
        </span>
      </td>
      <td>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          ${
            isDemo
              ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-primary">Open Test Console (Demo)</a>`
              : `<span class="badge" style="background: rgba(148, 163, 184, 0.1); color: var(--text-muted); border: 1px solid var(--border);">Console Restricted (Privacy)</span>`
          }
          <button class="btn btn-sm btn-secondary btn-edit-sub" data-tenant="${escapeHtml(t.id)}">Edit Subdomain</button>
          <button class="btn btn-sm btn-secondary btn-assign-custom" data-tenant="${escapeHtml(t.id)}">Assign Custom</button>
          ${t.custom_domain ? `<button class="btn btn-sm btn-danger btn-remove-custom" data-tenant="${escapeHtml(t.id)}">Disconnect</button>` : ""}
          ${
            t.status === "active"
              ? `<button class="btn btn-sm btn-danger btn-suspend" data-tenant="${escapeHtml(t.id)}">Suspend</button>`
              : t.status === "suspended"
                ? `<button class="btn btn-sm btn-success btn-reactivate" data-tenant="${escapeHtml(t.id)}">Reactivate</button>`
                : ""
          }
        </div>
      </td>
    </tr>
  `;
    })
    .join("");

  const navItems: NavItem[] = [
    {
      id: "schools",
      label: "Schools Directory",
      href: "/super/schools",
      badge: tenants.length,
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`
    },
    {
      id: "approvals",
      label: "Approvals Queue",
      href: "/super/approvals",
      badge: pendingCount > 0 ? pendingCount : undefined,
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
    { label: "Schools", value: tenants.length, color: "blue" },
    { label: "Online", value: `${totalOnline} / ${totalClients}`, color: "green" },
    { label: "Approvals", value: pendingCount, color: pendingCount > 0 ? "yellow" : "blue" }
  ];

  const subPanelHtml = `
    <div class="sub-section-title">Master Navigation</div>
    <div class="sub-action-list">
      <a href="/super/schools" class="sub-action-item ${activeTab === "schools" ? "active" : ""}">
        <span>Schools Directory</span>
        <span class="sub-action-badge">${tenants.length}</span>
      </a>
      <a href="/super/approvals" class="sub-action-item ${activeTab === "approvals" ? "active" : ""}">
        <span>Approvals Queue</span>
        ${pendingCount > 0 ? `<span class="sub-action-badge" style="color: #fde68a;">${pendingCount}</span>` : ""}
      </a>
      <a href="/super/catalogs" class="sub-action-item ${activeTab === "catalogs" ? "active" : ""}">
        <span>Translation Catalogs</span>
        <span class="sub-action-badge">${catalogList.length}</span>
      </a>
      <a href="/super/system" class="sub-action-item ${activeTab === "system" ? "active" : ""}">
        <span>System Health &amp; Logs</span>
      </a>
    </div>

    <div class="sub-section-title" style="margin-top: 16px;">Privacy Invariant</div>
    <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 11px; color: var(--text-muted); line-height: 1.5;">
      Super Admins cannot access any school's internal console or telemetry except for <code>demo</code>. School data isolation is enforced at the edge D1 layer.
    </div>
  `;

  const contentHtml = `
    <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: var(--radius); padding: 16px 22px; margin-bottom: 24px; display: flex; align-items: center; gap: 14px; font-size: 13px; color: #bfdbfe;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <div>
        <strong>Privacy Invariant Enforced:</strong> Platform Super Administrators cannot access individual school consoles or view student workstation telemetry. Consoles are accessible solely to authorized school instructors. The dedicated <code>demo</code> tenant is available for platform testing.
      </div>
    </div>

    <div class="tab-pane ${activeTab === "schools" ? "active" : ""}" id="pane-schools">
      <div class="card" style="padding: 0; overflow: hidden;">
        <div style="padding: 20px 24px; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
          <h2 class="card-title" style="margin-bottom: 0;">Registered Schools &amp; Institutions (${tenants.length})</h2>
        </div>
        <div class="table-container" style="border: none; border-radius: 0;">
          <table>
            <thead>
              <tr>
                <th>School Name</th>
                <th>Admin Contact</th>
                <th>Subdomain</th>
                <th>Custom Domain</th>
                <th>Status</th>
                <th>Workstations</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${allRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="tab-pane ${activeTab === "approvals" ? "active" : ""}" id="pane-approvals" style="display: ${activeTab === "approvals" ? "block" : "none"};">
      <div class="card">
        <h2 class="card-title">Pending Subdomain Requests (${pendingList.length})</h2>
        <p class="card-sub">Schools requesting initial activation or subdomain modifications.</p>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>School</th>
                <th>Contact</th>
                <th>Requested Subdomain</th>
                <th>Registered Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pendingSubdomainRows || `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 32px;">No pending subdomain requests.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">Pending Custom Domain Requests (${pendingCustomList.length})</h2>
        <p class="card-sub">Schools requesting custom institutional domains (e.g. <code>kiosk.myschool.edu</code>).</p>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>School</th>
                <th>Contact</th>
                <th>Requested Domain</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${pendingCustomRows || `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 32px;">No pending custom domain requests.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="tab-pane ${activeTab === "catalogs" ? "active" : ""}" id="pane-catalogs" style="display: ${activeTab === "catalogs" ? "block" : "none"};">
      <div class="card">
        <h2 class="card-title">Upload / Replace Translation Catalog</h2>
        <p class="card-sub">Deploy multi-language user interfaces to the first-boot setup wizard and top bar.</p>

        <form id="form-upload-catalog" style="max-width: 600px;">
          <div style="display: flex; gap: 12px; margin-bottom: 14px;">
            <div style="flex: 1;">
              <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Language Tag</label>
              <input type="text" id="catalog-tag" required placeholder="e.g. hi-IN or fr-FR" class="form-input">
            </div>
            <div style="flex: 1;">
              <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Display Name</label>
              <input type="text" id="catalog-name" placeholder="e.g. Hindi or Français" class="form-input">
            </div>
          </div>
          <div style="margin-bottom: 14px;">
            <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Direction</label>
            <select id="catalog-direction" class="form-select">
              <option value="ltr">LTR (Left to Right)</option>
              <option value="rtl">RTL (Right to Left)</option>
            </select>
          </div>
          <div style="margin-bottom: 16px;">
            <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Catalog JSON Content</label>
            <textarea id="catalog-json" rows="6" required placeholder='{"bar.home": "Home", ...}' class="form-textarea" style="font-family: 'JetBrains Mono', monospace; font-size: 12px;"></textarea>
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
              ${catalogRows || `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 32px;">No interface catalogs uploaded.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="tab-pane ${activeTab === "system" ? "active" : ""}" id="pane-system" style="display: ${activeTab === "system" ? "block" : "none"};">
      <div class="card">
        <h2 class="card-title">Platform Architecture &amp; Database Health</h2>
        <p class="card-sub">Cloudflare D1 edge database status and real-time operational telemetry.</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Database Engine</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #93c5fd;">Cloudflare D1 (SQLite)</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">Schema migrations: 0001..0007 applied</div>
          </div>
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Zero Runtime NPM</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #6ee7b7;">0 Dependencies</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">Native Web Crypto PBKDF2</div>
          </div>
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Client OS Overlay</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #fde68a;">100% RAM Overlay</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">overlayroot="tmpfs", 0 SSD Wear</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const scriptsHtml = `
    <script nonce="${escapeHtml(nonce)}">
      document.querySelectorAll(".btn-approve-sub").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const subdomain = btn.dataset.subdomain;
          if (!confirm("Approve subdomain '" + subdomain + "' for this school?")) return;
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
              alert(data.error || "Approval failed");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-reject-sub").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          if (!confirm("Reject this school's registration / subdomain request?")) return;
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
              alert(data.error || "Rejection failed");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-approve-custom").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const customDomain = btn.dataset.domain;
          if (!confirm("Approve custom domain '" + customDomain + "'?")) return;
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
              alert(data.error || "Custom domain approval failed");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-reject-custom").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          if (!confirm("Reject this custom domain request?")) return;
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
              alert(data.error || "Failed to reject custom domain");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-edit-sub").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const newSub = prompt("Enter new subdomain for this school:");
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
              alert(data.error || "Failed to assign subdomain");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-assign-custom").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const customDomain = prompt("Enter custom domain to assign (e.g. kiosk.myschool.edu):");
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
              alert(data.error || "Failed to assign custom domain");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-remove-custom").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          if (!confirm("Disconnect custom domain from this school?")) return;
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
              alert(data.error || "Failed to disconnect domain");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-suspend").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          if (!confirm("Suspend this school? Workstations and student portal will be deactivated.")) return;
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
              alert(data.error || "Failed to suspend school");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

      document.querySelectorAll(".btn-reactivate").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          if (!confirm("Reactivate this school?")) return;
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
              alert(data.error || "Failed to reactivate school");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });

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
            alert("Invalid JSON format");
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
              alert("Catalog uploaded successfully (" + data.entries + " entries)");
              window.location.reload();
            } else {
              alert(data.error || "Upload failed");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      }

      document.querySelectorAll(".btn-delete-catalog").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tag = btn.dataset.tag;
          if (!tag || !confirm("Delete interface catalog '" + tag + "'?")) return;
          try {
            const res = await fetch("/api/super/i18n/" + encodeURIComponent(tag), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              alert(data.error || "Failed to delete catalog");
            }
          } catch (err) {
            alert("Network error: " + err.message);
          }
        });
      });
    </script>
  `;

  return renderLayoutHtml({
    title: "Super Admin Master Console • Lab Kiosk SaaS",
    brandTitle: "Super Admin Master Console",
    brandSubtitle: `${baseDomain} • Global Governance`,
    brandIconSvg: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
    navItems,
    activeNavId: activeTab,
    subPanelTitle: "Platform Governance",
    subPanelSubtitle: "Global tenant administration",
    subPanelHtml,
    stats,
    userMeta: { name: "Super Admin", email: superAdminEmail, role: "Super Admin" },
    logoutAction: "/api/auth/logout",
    contentHtml,
    scriptsHtml,
    nonce
  });
}
