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
          <button class="btn btn-sm btn-success btn-approve-sub" data-tenant="${escapeAttr(t.id)}" data-subdomain="${escapeAttr(t.requested_subdomain || t.subdomain)}">Approve</button>
          <button class="btn btn-sm btn-secondary btn-edit-sub" data-tenant="${escapeAttr(t.id)}">Assign Custom</button>
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
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.admin_name)} <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.admin_email)}</div></td>
      <td>
        <span class="badge badge-yellow" style="font-family: 'JetBrains Mono', monospace;">
          ${escapeHtml(t.requested_custom_domain || "")}
        </span>
      </td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-sm btn-success btn-approve-custom" data-tenant="${escapeAttr(t.id)}" data-domain="${escapeAttr(t.requested_custom_domain || "")}">Approve Domain</button>
          <button class="btn btn-sm btn-danger btn-reject-custom" data-tenant="${escapeAttr(t.id)}">Reject</button>
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
              ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-primary">Open Test Console (Demo)</a>`
              : `<span class="badge" style="background: rgba(148, 163, 184, 0.1); color: var(--text-muted); border: 1px solid var(--border);">Console Restricted (Privacy)</span>`
          }
          <button class="btn btn-sm btn-secondary btn-edit-sub" data-tenant="${escapeAttr(t.id)}">Edit Subdomain</button>
          <button class="btn btn-sm btn-secondary btn-assign-custom" data-tenant="${escapeAttr(t.id)}">Assign Custom</button>
          ${t.custom_domain ? `<button class="btn btn-sm btn-danger btn-remove-custom" data-tenant="${escapeAttr(t.id)}">Disconnect</button>` : ""}
          ${
            t.status === "active"
              ? `<button class="btn btn-sm btn-danger btn-suspend" data-tenant="${escapeAttr(t.id)}">Suspend</button>`
              : t.status === "suspended"
                ? `<button class="btn btn-sm btn-success btn-reactivate" data-tenant="${escapeAttr(t.id)}">Reactivate</button>`
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

  // Each console tab renders on its own. The four panes used to be emitted
  // together and hidden with an inline `display`, except #pane-schools, which
  // carried no display rule and no matching CSS -- so the whole schools
  // directory, every tenant row included, rendered above the approvals,
  // catalogs and system pages as well.
  const bannerHtml = `    <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: var(--radius); padding: 16px 22px; margin-bottom: 24px; display: flex; align-items: center; gap: 14px; font-size: 13px; color: #bfdbfe;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <div>
        <strong>Privacy Invariant Enforced:</strong> Platform Super Administrators cannot access individual school consoles or view student workstation telemetry. Consoles are accessible solely to authorized school instructors. The dedicated <code>demo</code> tenant is available for platform testing.
      </div>
    </div>
  `;

  const schoolsPaneHtml = `
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
  `;

  const approvalsPaneHtml = `
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
  `;

  const catalogsPaneHtml = `
      <div class="card">
        <h2 class="card-title">Upload / Replace Translation Catalog</h2>
        <p class="card-sub">Deploy multi-language user interfaces to the first-boot setup wizard and top bar.</p>

        <form id="form-upload-catalog" style="max-width: 600px;">
          <div class="grid-2col" style="gap: 12px;">
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
            <textarea id="catalog-json" rows="6" required placeholder='{"bar.home": "Home", ...}' class="form-textarea" style="font-family: 'JetBrains Mono', monospace; font-size: 12px;"></textarea>
            <p class="form-hint">A flat map of string to string. Uploaded catalogs are platform-wide: never put anything school-specific in one.</p>
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
  `;

  const auditCardHtml = `
      <div class="card" id="platform-audit">
        <h2 class="card-title">Platform Action History</h2>
        <p class="card-sub">Catalog changes, and every platform action taken on a school. A school\u2019s own activity is not shown here and is not readable from this console.</p>
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
              <tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading\u2026</td></tr>
            </tbody>
          </table>
        </div>
      </div>
  `;

  const systemPaneHtml = `
      <div class="card">
        <h2 class="card-title">Platform Architecture &amp; Database Health</h2>
        <p class="card-sub">Cloudflare D1 edge database status and real-time operational telemetry.</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Database Engine</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #93c5fd;">Cloudflare D1 (SQLite)</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">Schema verified at boot by assertSchemaCurrent()</div>
          </div>
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Zero Runtime NPM</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #6ee7b7;">0 Dependencies</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">Native Web Crypto PBKDF2</div>
          </div>
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Client OS Overlay</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #fde68a;">100% RAM Overlay</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">overlayroot="tmpfs:recurse=0", 0 SSD Wear</div>
          </div>
        </div>
      </div>
${auditCardHtml}
  `;

  const panesByTab: Record<typeof activeTab, string> = {
    schools: schoolsPaneHtml,
    approvals: approvalsPaneHtml,
    catalogs: catalogsPaneHtml,
    system: systemPaneHtml
  };

  const contentHtml = `${bannerHtml}
${panesByTab[activeTab] || schoolsPaneHtml}`;

  const scriptsHtml = `
    <script nonce="${escapeAttr(nonce)}">
      document.querySelectorAll(".btn-approve-sub").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tenantId = btn.dataset.tenant;
          const subdomain = btn.dataset.subdomain;
          const agreed = await lkConfirm({
            title: "Approve '" + subdomain + "'?",
            message: "The console and student portal for this school go live on that address straight away, and its workstations can enrol against it.",
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
            message: "The school stays pending and cannot enrol workstations. Nothing is deleted, so you can approve it later.",
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
            message: "Traffic on that hostname will route to this school. Their DNS has to point at the worker before it resolves.",
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
            message: "The school keeps its subdomain address and can request a different domain later.",
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
            message: "The school reaches its console and portal at this address. Changing it breaks the old one immediately.",
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
            message: "The hostname the school owns. Their DNS has to point at this worker before it will resolve.",
            label: "Domain",
            placeholder: "kiosk.myschool.edu",
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
            message: "The school falls back to its subdomain. Workstations enrolled against the custom domain will need reconfiguring.",
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
            title: "Suspend this school?",
            message: "Its student portal stops serving, its workstations stop reporting and no new one can enrol. Nothing is deleted and you can reactivate at any time.",
            confirmLabel: "Suspend school",
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
              lkToast(data.error || "Failed to suspend school", "error");
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
            title: "Reactivate this school?",
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
              lkToast(data.error || "Failed to reactivate school", "error");
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
            cell.style.cssText = "text-align: center; color: var(--text-muted); padding: 24px;";
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
              when.style.cssText = "font-family: \u0027JetBrains Mono\u0027, monospace; font-size: 12px; white-space: nowrap;";
              when.textContent = new Date(entry.created_at * 1000).toISOString().slice(0, 16).replace("T", " ");
              row.appendChild(when);

              const action = document.createElement("td");
              const badge = document.createElement("span");
              // Red for what takes something away, green for what grants it.
              const removes = /suspend|reject|delete|remove/.test(entry.action);
              const grants = /approve|reactivate|upload/.test(entry.action);
              badge.className = "badge " + (removes ? "badge-red" : grants ? "badge-green" : "badge-blue");
              // textContent: an action string is data, and details carries a
              // school-supplied subdomain or domain.
              badge.textContent = entry.action;
              action.appendChild(badge);
              row.appendChild(action);

              const detail = document.createElement("td");
              detail.style.cssText = "color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere;";
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
            message: "Workstations set to that language fall back to English at their next start. The catalogs are platform-wide, so this affects every school.",
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
    brandIconSvg: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
    brandHref: "/super",
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
