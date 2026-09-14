/**
 * Super Admin Master Console UI
 * Platform owner interface for managing schools, approving subdomains, and global analytics.
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

export function renderSuperAdminHtml(data: {
  superAdminEmail: string;
  tenants: SuperConsoleTenant[];
  baseDomain?: string;
  /** Per-response CSP nonce; every <script> in this template must carry it. */
  nonce: string;
}): string {
  const { superAdminEmail, tenants, baseDomain = "labkiosk.akbhoi.com", nonce } = data;

  const pendingList = tenants.filter((t) => t.status === "pending" || t.requested_subdomain);
  const pendingCustomList = tenants.filter((t) => t.custom_domain_status === "pending" && t.requested_custom_domain);
  const activeList = tenants.filter((t) => t.status === "active" && !t.requested_subdomain);

  const totalClients = tenants.reduce((acc, t) => acc + (t.total_clients || 0), 0);
  const totalOnline = tenants.reduce((acc, t) => acc + (t.online_clients || 0), 0);

  // Every field below is school-supplied via public registration, so all of it
  // is escaped; actions carry their ids in data-* attributes rather than in
  // inline handler strings.
  const pendingRows = pendingList.map((t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.admin_name)} (${escapeHtml(t.admin_email)})</td>
      <td>
        <span class="subdomain-tag">
          ${
            t.requested_subdomain
              ? `<b>${escapeHtml(t.requested_subdomain)}</b> <span class="text-muted">(was ${escapeHtml(t.subdomain)})</span>`
              : `<b>${escapeHtml(t.subdomain)}</b>`
          }
        </span>
      </td>
      <td>${escapeHtml(new Date(t.created_at * 1000).toISOString().slice(0, 10))}</td>
      <td>
        <div class="action-btn-group">
          <button class="btn btn-sm btn-approve" data-action="approve" data-tenant="${escapeHtml(t.id)}" data-subdomain="${escapeHtml(t.requested_subdomain || t.subdomain)}">Approve</button>
          <button class="btn btn-sm btn-edit" data-action="assign" data-tenant="${escapeHtml(t.id)}">Custom Subdomain</button>
          <button class="btn btn-sm btn-reject" data-action="reject" data-tenant="${escapeHtml(t.id)}">Reject</button>
        </div>
      </td>
    </tr>
  `).join("");

  const pendingCustomRows = pendingCustomList.map((t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.admin_name)} (${escapeHtml(t.admin_email)})</td>
      <td>
        <span class="subdomain-tag" style="color: #fbbf24;">
          <b>${escapeHtml(t.requested_custom_domain)}</b>
        </span>
      </td>
      <td>
        <div class="action-btn-group">
          <button class="btn btn-sm btn-approve" data-action="approve-custom" data-tenant="${escapeHtml(t.id)}" data-domain="${escapeAttr(t.requested_custom_domain)}">Approve Domain</button>
          <button class="btn btn-sm btn-reject" data-action="reject-custom" data-tenant="${escapeHtml(t.id)}">Reject</button>
        </div>
      </td>
    </tr>
  `).join("");

  const allRows = tenants.map((t) => {
    const href = `/admin?tenant=${encodeURIComponent(t.subdomain)}`;
    return `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.admin_name)} (${escapeHtml(t.admin_email)})</td>
      <td>
        <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="subdomain-link">
          ${escapeHtml(t.subdomain)}.${escapeHtml(baseDomain)}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
        </a>
      </td>
      <td>
        ${
          t.custom_domain
            ? `<span class="status-badge status-active">ACTIVE</span> <a href="https://${escapeAttr(t.custom_domain)}" target="_blank" rel="noopener noreferrer" style="color: #6ee7b7; font-family: 'JetBrains Mono', monospace; font-size: 13px; margin-left: 6px;">${escapeHtml(t.custom_domain)}</a>`
            : t.custom_domain_status === "pending"
            ? `<span class="status-badge status-pending">PENDING</span> <span style="font-family: 'JetBrains Mono', monospace; font-size: 13px; margin-left: 6px; color: #fbbf24;">${escapeHtml(t.requested_custom_domain)}</span>`
            : `<span style="color: var(--muted);">&mdash;</span>`
        }
      </td>
      <td>
        <span class="status-badge status-${escapeHtml(t.status)}">${escapeHtml(String(t.status).toUpperCase())}</span>
      </td>
      <td>
        <span class="client-count">
          <span class="live-dot ${t.online_clients > 0 ? "active" : ""}"></span>
          ${Number(t.online_clients) || 0} / ${Number(t.total_clients) || 0}
        </span>
      </td>
      <td>
        <div class="action-btn-group">
          <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-secondary">Open Console</a>
          <button class="btn btn-sm btn-edit" data-action="assign" data-tenant="${escapeHtml(t.id)}">Edit Subdomain</button>
          <button class="btn btn-sm btn-edit" data-action="assign-custom" data-tenant="${escapeHtml(t.id)}">Assign Custom Domain</button>
          ${t.custom_domain ? `<button class="btn btn-sm btn-reject" data-action="remove-custom" data-tenant="${escapeHtml(t.id)}">Disconnect</button>` : ""}
          ${
            t.status === "active"
              ? `<button class="btn btn-sm btn-reject" data-action="suspend" data-tenant="${escapeHtml(t.id)}">Suspend</button>`
              : t.status === "suspended"
                ? `<button class="btn btn-sm btn-approve" data-action="reactivate" data-tenant="${escapeHtml(t.id)}">Reactivate</button>`
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
      --panel: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #3b82f6;
      --green: #10b981;
      --red: #ef4444;
      --amber: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 16px 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
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
      border-radius: 6px; font-size: 12px; cursor: pointer; text-decoration: none;
    }
    main { padding: 36px; max-width: 1400px; width: 100%; margin: 0 auto; flex: 1; }
    .stats-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 36px;
    }
    .stat-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 22px;
    }
    .stat-label { font-size: 13px; color: var(--muted); font-weight: 600; text-transform: uppercase; margin-bottom: 8px; }
    .stat-value { font-size: 32px; font-weight: 800; font-family: 'JetBrains Mono', monospace; }
    .section-title { font-size: 20px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; }
    .queue-badge {
      background: var(--amber); color: #000; font-size: 12px; padding: 2px 8px; border-radius: 12px; font-weight: 700;
    }
    .table-container {
      background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
      overflow-x: auto; -webkit-overflow-scrolling: touch; margin-bottom: 40px;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th { background: #162032; padding: 14px 18px; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
    td { padding: 14px 18px; border-bottom: 1px solid rgba(51, 65, 85, 0.4); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .subdomain-tag { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #93c5fd; }
    .subdomain-link {
      font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #60a5fa; text-decoration: none;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .subdomain-link:hover { text-decoration: underline; }
    .status-badge {
      padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; display: inline-block;
    }
    .status-active { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .status-pending { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .status-suspended { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .status-rejected { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; }
    .text-muted { color: var(--muted); }
    .client-count { display: flex; align-items: center; gap: 8px; font-family: 'JetBrains Mono', monospace; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #475569; }
    .live-dot.active { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .action-btn-group { display: flex; gap: 8px; }
    .btn {
      border: 1px solid transparent; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
      cursor: pointer; text-decoration: none; transition: all 0.15s ease;
    }
    .btn-approve { background: #059669; color: #fff; }
    .btn-approve:hover { background: #10b981; }
    .btn-reject { background: #b91c1c; color: #fff; }
    .btn-reject:hover { background: #ef4444; }
    .btn-edit { background: #1e293b; border-color: var(--border); color: var(--text); }
    .btn-edit:hover { background: #334155; }
    .btn-secondary { background: #1e293b; border-color: var(--border); color: var(--text); }
    .btn-secondary:hover { background: #3b82f6; color: #fff; }
    .empty-state { padding: 32px; text-align: center; color: var(--muted); font-size: 14px; }

    /* Mobile & Tablet Responsiveness */
    @media (max-width: 768px) {
      header { padding: 12px 16px; flex-wrap: wrap; gap: 10px; }
      .user-meta { width: 100%; justify-content: space-between; }
      main { padding: 20px 14px; }
      .stats-grid { grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
      .stat-value { font-size: 24px; }
      table { min-width: 620px; }
    }
    /* Modal Dialog */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(6px);
      display: none; align-items: center; justify-content: center; z-index: 2000; padding: 20px;
    }
    .modal-overlay.active { display: flex; }
    .modal-box {
      background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
      padding: 24px; max-width: 440px; width: 100%; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
    }
    .modal-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    .form-group { margin-bottom: 14px; }
    .form-label { display: block; font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 6px; }
    .form-input {
      width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 10px 12px; color: var(--text); font-size: 14px; outline: none; font-family: inherit;
    }
    .form-input:focus { border-color: var(--accent); }
    .form-error { color: var(--red); font-size: 12px; margin-top: 6px; min-height: 16px; }
    .form-success { color: var(--green); font-size: 12px; margin-top: 6px; min-height: 16px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo">M</div>
      <div>
        <div class="brand-title">Lab Kiosk Master Control</div>
        <div class="brand-sub">Platform Super Administrator Console</div>
      </div>
    </div>
    <div class="user-meta">
      <span class="badge-super">SUPER ADMIN</span>
      <span style="font-size: 13px; color: var(--muted);">${escapeHtml(superAdminEmail)}</span>
      <button type="button" class="btn-logout" id="btn-change-password">Change Password</button>
      <form method="post" action="/api/auth/logout" style="display: inline;">
        <button type="submit" class="btn-logout">Sign Out</button>
      </form>
    </div>
  </header>

  <main>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Schools</div>
        <div class="stat-value" style="color: #60a5fa;">${tenants.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Subdomains</div>
        <div class="stat-value" style="color: #34d399;">${activeList.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pending Approvals</div>
        <div class="stat-value" style="color: #fbbf24;">${pendingList.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Live Thin Clients</div>
        <div class="stat-value" style="color: #f472b6;">${totalOnline} <span style="font-size: 16px; color: var(--muted);">/ ${totalClients}</span></div>
      </div>
    </div>

    <!-- Subdomain Approval Queue -->
    <h2 class="section-title">
      Subdomain Approval Queue
      ${pendingList.length > 0 ? `<span class="queue-badge">${pendingList.length} ACTION REQUIRED</span>` : ""}
    </h2>
    <div class="table-container">
      ${pendingList.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>School / Lab Name</th>
              <th>Admin Contact</th>
              <th>Requested Subdomain</th>
              <th>Registration Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pendingRows}
          </tbody>
        </table>
      ` : `
        <div class="empty-state">No pending subdomain requests. All schools are currently approved!</div>
      `}
    </div>

    <!-- Custom Domain Approval Queue -->
    ${pendingCustomList.length > 0 ? `
      <h2 class="section-title" style="color: #fbbf24;">
        Custom Domain Approval Queue
        <span class="queue-badge" style="background: #fbbf24; color: #000;">${pendingCustomList.length} ACTION REQUIRED</span>
      </h2>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>School / Lab Name</th>
              <th>Admin Contact</th>
              <th>Requested Custom Domain</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pendingCustomRows}
          </tbody>
        </table>
      </div>
    ` : ""}

    <!-- All Registered Schools -->
    <h2 class="section-title">Registered Schools & Computer Labs</h2>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>School Name</th>
            <th>Admin Contact</th>
            <th>Subdomain URL</th>
            <th>Custom Domain</th>
            <th>Status</th>
            <th>Live Workstations</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${allRows}
        </tbody>
      </table>
    </div>
  </main>

  <!-- Password Change Modal -->
  <div class="modal-overlay" id="password-modal">
    <div class="modal-box">
      <div class="modal-title">Change Super Admin Password</div>
      <p style="font-size: 13px; color: var(--muted); margin-bottom: 16px;">
        Updating your password will revoke all other active super administrator sessions.
      </p>
      <form id="password-form">
        <div class="form-group">
          <label class="form-label" for="super-curr-pwd">Current Password</label>
          <input type="password" id="super-curr-pwd" class="form-input" required autocomplete="current-password">
        </div>
        <div class="form-group">
          <label class="form-label" for="super-new-pwd">New Password</label>
          <input type="password" id="super-new-pwd" class="form-input" required minlength="12" autocomplete="new-password" placeholder="At least 12 characters, letters and numbers">
        </div>
        <div class="form-group">
          <label class="form-label" for="super-confirm-pwd">Confirm New Password</label>
          <input type="password" id="super-confirm-pwd" class="form-input" required minlength="12" autocomplete="new-password">
        </div>
        <div id="password-status-msg" class="form-error"></div>
        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px;">
          <button type="button" class="btn btn-secondary" id="btn-cancel-password">Cancel</button>
          <button type="submit" class="btn btn-approve" id="btn-submit-password">Update Password</button>
        </div>
      </form>
    </div>
  </div>

  <script nonce="${escapeAttr(nonce)}">
    async function postJson(endpoint, payload) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      let data = {};
      try {
        data = await res.json();
      } catch (err) {
        console.error("Unreadable response from " + endpoint, err);
      }
      if (res.ok && data.status === "ok") {
        window.location.reload();
        return;
      }
      alert(data.error || "Request failed (" + res.status + ")");
    }

    // Delegated so no tenant-supplied value is ever placed in an inline handler.
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;

      const tenantId = button.dataset.tenant;
      const action = button.dataset.action;

      if (action === "approve") {
        const subdomain = button.dataset.subdomain || "";
        if (!confirm("Approve subdomain '" + subdomain + "' for this school?")) return;
        postJson("/api/super/tenants/approve", { tenantId, subdomain });
      } else if (action === "reject") {
        if (!confirm("Reject this school's subdomain request?")) return;
        postJson("/api/super/tenants/reject", { tenantId });
      } else if (action === "assign") {
        const custom = prompt("Enter the exact subdomain slug to assign (lowercase letters, numbers, hyphens):");
        if (!custom) return;
        postJson("/api/super/tenants/approve", { tenantId, subdomain: custom.toLowerCase().trim() });
      } else if (action === "approve-custom") {
        const customDomain = button.dataset.domain || "";
        if (!confirm("Approve custom domain '" + customDomain + "' for this school?")) return;
        postJson("/api/super/tenants/custom-domain/approve", { tenantId, customDomain });
      } else if (action === "reject-custom") {
        if (!confirm("Reject this custom domain request?")) return;
        postJson("/api/super/tenants/custom-domain/reject", { tenantId });
      } else if (action === "assign-custom") {
        const custom = prompt("Enter the fully qualified custom domain (e.g. kiosk.myschool.edu):");
        if (!custom) return;
        postJson("/api/super/tenants/custom-domain/approve", { tenantId, customDomain: custom.toLowerCase().trim() });
      } else if (action === "remove-custom") {
        if (!confirm("Disconnect custom domain from this school?")) return;
        postJson("/api/super/tenants/custom-domain/remove", { tenantId });
      } else if (action === "suspend") {
        if (!confirm("Suspend this school? Its portal and workstations stop working until it is reactivated.")) return;
        postJson("/api/super/tenants/suspend", { tenantId });
      } else if (action === "reactivate") {
        if (!confirm("Reactivate this school?")) return;
        postJson("/api/super/tenants/reactivate", { tenantId });
      }
    });

    const pwdModal = document.getElementById("password-modal");
    const pwdForm = document.getElementById("password-form");
    const currPwdInput = document.getElementById("super-curr-pwd");
    const newPwdInput = document.getElementById("super-new-pwd");
    const confirmPwdInput = document.getElementById("super-confirm-pwd");
    const pwdStatus = document.getElementById("password-status-msg");

    function openPasswordModal() {
      pwdForm.reset();
      pwdStatus.textContent = "";
      pwdStatus.className = "form-error";
      pwdModal.classList.add("active");
      currPwdInput.focus();
    }
    function closePasswordModal() {
      pwdModal.classList.remove("active");
    }

    document.getElementById("btn-change-password").addEventListener("click", openPasswordModal);
    document.getElementById("btn-cancel-password").addEventListener("click", closePasswordModal);
    pwdModal.addEventListener("click", (e) => {
      if (e.target === pwdModal) closePasswordModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pwdModal.classList.contains("active")) closePasswordModal();
    });

    pwdForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      pwdStatus.textContent = "";
      pwdStatus.className = "form-error";

      const currentPassword = currPwdInput.value;
      const newPassword = newPwdInput.value;
      const confirmPassword = confirmPwdInput.value;

      if (newPassword !== confirmPassword) {
        pwdStatus.textContent = "New passwords do not match.";
        return;
      }

      const submitBtn = document.getElementById("btn-submit-password");
      submitBtn.disabled = true;
      submitBtn.textContent = "Updating...";

      try {
        const res = await fetch("/api/auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        let data = {};
        try { data = await res.json(); } catch {}
        if (res.ok && data.status === "ok") {
          pwdStatus.className = "form-success";
          pwdStatus.textContent = "Password changed successfully. Other sessions revoked.";
          setTimeout(closePasswordModal, 1500);
        } else {
          pwdStatus.textContent = data.error || "Password change failed (" + res.status + ")";
        }
      } catch (err) {
        pwdStatus.textContent = "Network error. Please try again.";
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Update Password";
      }
    });
  </script>
</body>
</html>`;
}
