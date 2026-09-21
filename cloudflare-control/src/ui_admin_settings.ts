/**
 * Lab settings: identity, routing, custom domain, enrollment key, the audit
 * trail and the administrator password.
 *
 * The page markup, its context-panel contents and its client script live
 * together here. They used to sit hundreds of lines apart inside one
 * 2,450-line module, which is how a panel full of controls that nothing
 * handled went unnoticed for so long.
 */

import { LabConfig, Tenant } from "./types";
import { escapeHtml, escapeAttr } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildSettingsPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, teachers, tenantParam, baseDomain, nonce } = options;
  return {
    title: "Lab Settings & Configuration",
    contentHtml: renderSettingsPageHtml(tenant, config, baseDomain),
    scriptsHtml: renderSettingsScripts(nonce),
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
            <a href="#section-activity" class="sub-action-item">
              <span>Recent Lab Activity</span>
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
}

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
      <div class="card" id="section-activity">
        <h2 class="card-title">Recent Lab Activity</h2>
        <p class="card-sub">Privileged changes to this lab, including anything the platform did to it. Every one of these was already being recorded; this is the first place it can be read.</p>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody id="lab-audit-rows">
              <tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading\u2026</td></tr>
            </tbody>
          </table>
        </div>
      </div>

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
            lkToastAfterReload("Profile settings saved.", "success");
            window.location.reload();
          } else {
            lkToast(data.error || "Failed to save settings", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      document.getElementById("form-subdomain-settings").addEventListener("submit", async (e) => {
        e.preventDefault();
        const subdomain = document.getElementById("setting-subdomain").value.trim().toLowerCase();
        const agreed = await lkConfirm({
          title: "Move the lab to '" + subdomain + "'?",
          message: "The current address stops working once this is approved, and every enrolled workstation needs its configuration updated to the new one.",
          confirmLabel: "Request change"
        });
        if (!agreed) return;

        try {
          const res = await fetch(labkioskApi("/api/tenant/subdomain"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subdomain })
          });
          const data = await res.json();
          if (data.status === "ok") {
            lkToastAfterReload("Subdomain updated. This is the new console address.", "success");
            window.location.href = data.redirectUrl || "/admin";
          } else {
            lkToast(data.error || "Failed to update subdomain", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
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
              lkToastAfterReload("Custom domain submitted for platform review.", "success");
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to submit custom domain", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

      const disconnectBtn = document.getElementById("btn-disconnect-custom");
      if (disconnectBtn) {
        disconnectBtn.addEventListener("click", async () => {
          const agreed = await lkConfirm({
            title: "Disconnect the custom domain?",
            message: "The lab goes back to its subdomain address. Workstations enrolled against the custom domain will need reconfiguring.",
            confirmLabel: "Disconnect",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch(labkioskApi("/api/settings/custom-domain"), { method: "DELETE" });
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
      }

      const cancelCustomBtn = document.getElementById("btn-cancel-custom");
      if (cancelCustomBtn) {
        cancelCustomBtn.addEventListener("click", async () => {
          try {
            await fetch(labkioskApi("/api/settings/custom-domain"), { method: "DELETE" });
            window.location.reload();
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
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
            lkToast("Routing saved.", "success");
          } else {
            lkToast(data.error || "Failed to save routing", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
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
            lkToast("Tunnel domain updated.", "success");
          } else {
            lkToast(data.error || "Failed to update tunnel", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
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
            lkToast("Failed to fetch key", "error");
          }
        } else {
          try {
            await navigator.clipboard.writeText(display.textContent);
            lkToast("Enrollment key copied to the clipboard.", "success");
          } catch (err) {
            // A denied permission, or a page served over plain http. Say so
            // rather than reporting a copy that did not happen.
            lkToast("Could not reach the clipboard. Select the key above and copy it by hand.", "warning");
          }
        }
      });

      document.getElementById("btn-rotate-key").addEventListener("click", async () => {
        const agreed = await lkConfirm({
          title: "Rotate the enrollment key?",
          message: "Workstations already enrolled keep working. Any machine enrolled from now on needs the new key, so update whatever you hand to staff.",
          confirmLabel: "Rotate key"
        });
        if (!agreed) return;
        try {
          const res = await fetch(labkioskApi("/api/settings/enrollment-key"), { method: "POST" });
          const data = await res.json();
          if (data.status === "ok") {
            document.getElementById("enrollment-key-display").textContent = data.enrollmentKey;
            lkToast("Enrollment key rotated. The new key is shown above.", "success");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      const labAuditRows = document.getElementById("lab-audit-rows");
      if (labAuditRows) {
        (async function loadLabActivity() {
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
            const res = await fetch(labkioskApi("/api/audit-logs?limit=60"));
            const data = await res.json();
            const logs = Array.isArray(data.logs) ? data.logs : [];
            labAuditRows.replaceChildren();
            if (!logs.length) {
              labAuditRows.appendChild(placeholder("Nothing recorded for this lab yet."));
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
              const removes = /suspend|reject|delete|remove|revoke|rotate/.test(entry.action);
              const grants = /approve|reactivate|create|add/.test(entry.action);
              badge.className = "badge " + (removes ? "badge-red" : grants ? "badge-green" : "badge-blue");
              // textContent throughout: details carries teacher names, domains
              // and URLs that arrived from the console.
              badge.textContent = entry.action;
              action.appendChild(badge);
              row.appendChild(action);

              const detail = document.createElement("td");
              detail.style.cssText = "color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere;";
              detail.textContent = entry.details || "\u2014";
              row.appendChild(detail);

              labAuditRows.appendChild(row);
            }
          } catch (err) {
            labAuditRows.replaceChildren();
            labAuditRows.appendChild(placeholder("Could not load recent activity."));
          }
        })();
      }

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
            lkToast("Password updated successfully.", "success");
            document.getElementById("form-change-password").reset();
          } else {
            lkToast(data.error || "Failed to change password", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });
    </script>
  `;
}
