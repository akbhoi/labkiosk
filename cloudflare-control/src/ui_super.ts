/**
 * Super Admin Master Console UI
 * Platform owner interface for managing schools, approving subdomains, and global analytics.
 * Strictly enforces privacy: Super admin cannot access school consoles except demo.
 */

import { Tenant } from "./types";
import { escapeHtml, escapeAttr } from "./escape";

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
  const catalogRows = catalogList.map((c) => `
    <tr>
      <td><strong>${escapeHtml(c.tag)}</strong></td>
      <td>${escapeHtml(c.name)}</td>
      <td><span class="badge badge-blue">${escapeHtml(c.direction.toUpperCase())}</span></td>
      <td>${Number(c.entry_count) || 0}</td>
      <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px;">${c.updated_at && Number.isFinite(c.updated_at) ? escapeHtml(new Date(c.updated_at * 1000).toISOString().slice(0, 16).replace("T", " ")) : "-"}</td>
      <td>
        <button class="btn btn-sm btn-danger btn-delete-catalog" data-tag="${escapeAttr(c.tag)}">Delete</button>
      </td>
    </tr>
  `).join("");

  const pendingSubdomainRows = pendingList.map((t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.admin_name)} <div style="font-size: 12px; color: var(--muted);">${escapeHtml(t.admin_email)}</div></td>
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
  `).join("");

  const pendingCustomRows = pendingCustomList.map((t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.admin_name)} <div style="font-size: 12px; color: var(--muted);">${escapeHtml(t.admin_email)}</div></td>
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
  `).join("");

  const allRows = tenants.map((t) => {
    const isDemo = t.subdomain === "demo";
    const href = `/admin?tenant=${encodeURIComponent(t.subdomain)}`;
    return `
    <tr>
      <td>
        <strong>${escapeHtml(t.name)}</strong>
        ${isDemo ? `<span class="badge badge-blue" style="margin-left: 6px;">DEMO TENANT</span>` : ""}
      </td>
      <td>${escapeHtml(t.admin_name)} <div style="font-size: 12px; color: var(--muted);">${escapeHtml(t.admin_email)}</div></td>
      <td>
        <span style="font-family: 'JetBrains Mono', monospace; font-size: 13px;">${escapeHtml(t.subdomain)}.${escapeHtml(baseDomain)}</span>
      </td>
      <td>
        ${
          t.custom_domain
            ? `<span class="badge badge-green">ACTIVE</span> <span style="color: #6ee7b7; font-family: 'JetBrains Mono', monospace; font-size: 12px; margin-left: 6px;">${escapeHtml(t.custom_domain)}</span>`
            : t.custom_domain_status === "pending"
            ? `<span class="badge badge-yellow">PENDING</span> <span style="font-family: 'JetBrains Mono', monospace; font-size: 12px; margin-left: 6px; color: #fbbf24;">${escapeHtml(t.requested_custom_domain || "")}</span>`
            : `<span style="color: var(--muted);">&mdash;</span>`
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
              : `<span class="badge" style="background: rgba(148, 163, 184, 0.1); color: var(--muted); border: 1px solid var(--border);">Console Restricted (Privacy)</span>`
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
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Super Admin Master Console - Lab Kiosk SaaS</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --surface: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --border-subtle: #243044;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --green: #10b981;
      --red: #ef4444;
      --yellow: #f59e0b;
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
    
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 1000;
    }
    .header-top {
      padding: 14px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo {
      width: 38px; height: 38px; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
      border-radius: 10px; display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 18px; color: #fff;
    }
    .brand-title { font-size: 18px; font-weight: 800; }
    .brand-sub { font-size: 12px; color: var(--muted); }

    .user-meta { display: flex; align-items: center; gap: 16px; }
    .badge-super {
      background: rgba(236, 72, 153, 0.15); color: #f472b6; border: 1px solid rgba(236, 72, 153, 0.3);
      padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 700;
    }
    .btn-logout {
      background: #1e293b; border: 1px solid var(--border); color: var(--text); padding: 6px 14px;
      border-radius: 6px; font-size: 12px; cursor: pointer;
    }

    /* Tabs */
    .tab-bar {
      padding: 0 32px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-top: 1px solid var(--border-subtle);
    }
    .tab-btn {
      padding: 12px 16px;
      color: var(--muted);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      border-bottom: 2px solid transparent;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
    }
    .tab-btn:hover { color: #fff; }
    .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); background: rgba(59, 130, 246, 0.05); }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    main { flex: 1; max-width: 1720px; width: 100%; margin: 0 auto; padding: 28px 32px 60px; }

    .stats-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 22px;
    }
    .stat-title { font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-num { font-size: 28px; font-weight: 800; margin-top: 6px; }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      margin-bottom: 28px;
    }
    .card-title { font-size: 18px; font-weight: 700; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
    .card-sub { font-size: 13px; color: var(--muted); margin-bottom: 18px; }

    .table-container {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th {
      background: var(--card);
      padding: 12px 16px;
      font-weight: 700;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    td { padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255, 255, 255, 0.015); }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.2s;
      text-decoration: none;
      font-family: inherit;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-secondary { background: var(--card); color: var(--text); border-color: var(--border); }
    .btn-success { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border-color: rgba(16, 185, 129, 0.3); }
    .btn-danger { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
    .btn-sm { padding: 4px 10px; font-size: 11px; }

    .badge {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 12px;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .badge-green { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-blue { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.3); }
    .badge-yellow { background: rgba(245, 158, 11, 0.15); color: #fde68a; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-red { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }

    .stat-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
    .dot-green { background: var(--green); box-shadow: 0 0 6px var(--green); }
    .dot-red { background: var(--red); }

    .privacy-callout {
      background: rgba(59, 130, 246, 0.08);
      border: 1px solid rgba(59, 130, 246, 0.25);
      border-radius: var(--radius);
      padding: 16px 22px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 13px;
      color: #bfdbfe;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="brand">
        <div class="brand-logo">S</div>
        <div>
          <div class="brand-title">Super Admin Master Console</div>
          <div class="brand-sub">Platform Management &amp; School Governance • ${escapeHtml(baseDomain)}</div>
        </div>
      </div>

      <div class="user-meta">
        <span class="badge-super">PLATFORM SUPER ADMIN</span>
        <span style="font-size: 13px; color: var(--muted);">${escapeHtml(superAdminEmail)}</span>
        <form action="/api/auth/logout" method="POST" style="margin: 0;">
          <button type="submit" class="btn-logout">Sign Out</button>
        </form>
      </div>
    </div>

    <nav class="tab-bar">
      <a href="/super/schools" class="tab-btn ${activeTab === "schools" ? "active" : ""}">
        Schools Directory (${tenants.length})
      </a>
      <a href="/super/approvals" class="tab-btn ${activeTab === "approvals" ? "active" : ""}">
        Approvals Queue ${pendingCount > 0 ? `<span class="badge badge-yellow">${pendingCount}</span>` : ""}
      </a>
      <a href="/super/catalogs" class="tab-btn ${activeTab === "catalogs" ? "active" : ""}">
        Translation Catalogs (${catalogList.length})
      </a>
      <a href="/super/system" class="tab-btn ${activeTab === "system" ? "active" : ""}">
        System Health &amp; Logs
      </a>
    </nav>
  </header>

  <main>
    <div class="privacy-callout">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <div>
        <strong>Privacy Invariant Enforced:</strong> Platform Super Administrators cannot access individual school consoles or view student workstation telemetry. Consoles are accessible solely to authorized school instructors. The dedicated <code>demo</code> tenant is available for platform testing.
      </div>
    </div>

    <div class="stats-strip">
      <div class="stat-card">
        <div class="stat-title">Total Schools</div>
        <div class="stat-num">${tenants.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Connected Workstations</div>
        <div class="stat-num">${totalOnline} <span style="font-size: 16px; color: var(--muted); font-weight: 500;">/ ${totalClients}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Pending Approvals</div>
        <div class="stat-num" style="color: ${pendingCount > 0 ? "var(--yellow)" : "inherit"};">${pendingCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Platform Edge Status</div>
        <div class="stat-num" style="color: var(--green); font-size: 20px; display: flex; align-items: center; gap: 8px; margin-top: 10px;">
          <span class="stat-dot dot-green"></span> Operational
        </div>
      </div>
    </div>

    <div class="tab-pane ${activeTab === "schools" ? "active" : ""}" id="pane-schools">
      <div class="card" style="padding: 0; overflow: hidden;">
        <div style="padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
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

    <div class="tab-pane ${activeTab === "approvals" ? "active" : ""}" id="pane-approvals">
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
              ${pendingSubdomainRows || `<tr><td colspan="5" style="text-align: center; color: var(--muted); padding: 32px;">No pending subdomain requests.</td></tr>`}
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
              ${pendingCustomRows || `<tr><td colspan="4" style="text-align: center; color: var(--muted); padding: 32px;">No pending custom domain requests.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="tab-pane ${activeTab === "catalogs" ? "active" : ""}" id="pane-catalogs">
      <div class="card">
        <h2 class="card-title">Upload / Replace Translation Catalog</h2>
        <p class="card-sub">Deploy multi-language user interfaces to the first-boot setup wizard and top bar.</p>

        <form id="form-upload-catalog" style="max-width: 600px;">
          <div style="display: flex; gap: 12px; margin-bottom: 14px;">
            <div style="flex: 1;">
              <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Language Tag</label>
              <input type="text" id="catalog-tag" required placeholder="e.g. hi-IN or fr-FR" style="width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: #fff;">
            </div>
            <div style="flex: 1;">
              <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Display Name</label>
              <input type="text" id="catalog-name" placeholder="e.g. Hindi or Français" style="width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: #fff;">
            </div>
          </div>
          <div style="margin-bottom: 14px;">
            <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Direction</label>
            <select id="catalog-direction" style="width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: #fff;">
              <option value="ltr">LTR (Left to Right)</option>
              <option value="rtl">RTL (Right to Left)</option>
            </select>
          </div>
          <div style="margin-bottom: 16px;">
            <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Catalog JSON Content</label>
            <textarea id="catalog-json" rows="6" required placeholder='{"bar.home": "Home", ...}' style="width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 12px;"></textarea>
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
              ${catalogRows || `<tr><td colspan="6" style="text-align: center; color: var(--muted); padding: 32px;">No interface catalogs uploaded.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="tab-pane ${activeTab === "system" ? "active" : ""}" id="pane-system">
      <div class="card">
        <h2 class="card-title">Platform Architecture &amp; Database Health</h2>
        <p class="card-sub">Cloudflare D1 edge database status and real-time operational telemetry.</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--muted); text-transform: uppercase; font-weight: 700;">Database Engine</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #93c5fd;">Cloudflare D1 (SQLite)</div>
            <div style="font-size: 12px; color: var(--muted); margin-top: 6px;">Schema migrations: 0001..0007 applied</div>
          </div>
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--muted); text-transform: uppercase; font-weight: 700;">Zero Runtime NPM</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #6ee7b7;">0 Dependencies</div>
            <div style="font-size: 12px; color: var(--muted); margin-top: 6px;">Native Web Crypto PBKDF2</div>
          </div>
          <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px;">
            <div style="font-size: 12px; color: var(--muted); text-transform: uppercase; font-weight: 700;">Client OS Overlay</div>
            <div style="font-size: 18px; font-weight: 800; margin-top: 4px; color: #fde68a;">100% RAM Overlay</div>
            <div style="font-size: 12px; color: var(--muted); margin-top: 6px;">overlayroot="tmpfs", 0 SSD Wear</div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <script nonce="${escapeHtml(nonce)}">
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const href = btn.getAttribute("href") || "";
        const tab = href.split("/").pop();
        if (tab && document.getElementById("pane-" + tab)) {
          e.preventDefault();
          document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
          document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
          btn.classList.add("active");
          document.getElementById("pane-" + tab).classList.add("active");
          try { history.pushState(null, "", href); } catch {}
        }
      });
    });

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
</body>
</html>`;
}
