/**
 * Settings: identity, routing, custom domain, enrollment key, the audit
 * trail and the administrator password.
 *
 * The page markup, its context-panel contents and its client script live
 * together here. They used to sit hundreds of lines apart inside one
 * 2,450-line module, which is how a panel full of controls that nothing
 * handled went unnoticed for so long.
 */

import { LabConfig, Tenant, HomepageBlock } from "./types";
import { parseHomepageBlocks } from "./db";
import { escapeHtml, escapeAttr , escapeJson } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildSettingsPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, staff, tenantParam, baseDomain, nonce } = options;
  return {
    title: "Settings & Configuration",
    contentHtml: renderSettingsPageHtml(tenant, config, baseDomain, tenantParam),
    scriptsHtml: renderSettingsScripts(nonce, parseHomepageBlocks(tenant?.homepage_blocks)),
    subPanelTitle: "Organization Settings",
    subPanelSubtitle: "Settings & preferences",
    subPanelHtml: `
      <div class="sub-section-title">Settings Views</div>
      <div class="sub-action-list" id="sub-tab-list">
        <button type="button" class="sub-action-item active" data-action="tab-general">
          <span class="row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            General &amp; Kiosk
          </span>
        </button>
        <button type="button" class="sub-action-item" data-action="tab-domains">
          <span class="row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Domains &amp; Network
          </span>
        </button>
        <button type="button" class="sub-action-item" data-action="tab-homepage">
          <span class="row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            Organization Homepage
          </span>
        </button>
        <button type="button" class="sub-action-item" data-action="tab-security">
          <span class="row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            Security &amp; Audit
          </span>
        </button>
      </div>

      <div class="sub-section-title">Quick Shortcuts</div>
      <div class="sub-action-list">
        <a href="/${tenantParam}" target="_blank" rel="noopener noreferrer" class="sub-action-item">
          <span class="row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Preview Organization Homepage
          </span>
        </a>
      </div>

      <div class="sub-section-title">Security Architecture</div>
      <div class="panel-note">
        Passwords hashed with PBKDF2-HMAC-SHA256 (100k rounds) via WebCrypto. Device tokens authenticated per 3s heartbeat.
      </div>
    `
  };
}

function renderSettingsPageHtml(tenant: Tenant | undefined, config: LabConfig | undefined, baseDomain: string, tenantParam: string): string {
  const currentSubdomain = tenant?.subdomain || "";
  const customDomain = tenant?.custom_domain || "";
  const customDomainStatus = tenant?.custom_domain_status || "none";
  const homeRoute = tenant?.home_route || "/home";
  const tunnelDomain = tenant?.tunnel_domain || config?.tunnelDomain || "";

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Settings</h1>
        <p class="page-desc">Organization profile, kiosk behaviour, addresses and remote access, the homepage, and security.</p>
      </div>
    </div>

    <!-- ============================================================== -->
    <!-- TAB 1: GENERAL & KIOSK PROFILE                                 -->
    <!-- ============================================================== -->
    <div class="tab-pane active" id="pane-general">
      <div class="grid-2col">
        <!-- Card 1: Lab Profile & Kiosk Mode -->
        <div class="card" id="section-general">
          <h2 class="card-title">Organization &amp; Kiosk Profile</h2>
          <p class="card-sub">General settings for this organization's workstations.</p>

          <form id="form-profile-settings">
            <div class="form-group">
              <label class="form-label" for="setting-organization-name">Organization Name</label>
              <input type="text" class="form-input" id="setting-organization-name" value="${escapeAttr(tenant?.name || "")}" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="setting-kiosk-mode">Kiosk Display Mode</label>
              <select class="form-select" id="setting-kiosk-mode">
                <option value="portal" ${tenant?.mode === "portal" ? "selected" : ""}>User Portal (Card Grid)</option>
                <option value="single_url" ${tenant?.mode === "single_url" ? "selected" : ""}>Direct Single-Site Lockdown</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="setting-default-url">Direct Lockdown URL (for Single-Site Mode)</label>
              <input type="url" class="form-input" id="setting-default-url" value="${escapeAttr(tenant?.default_url || "https://www.khanacademy.org")}">
            </div>
            <div class="form-group">
              <label class="form-label" for="setting-lock-msg">Default Lock Screen Message</label>
              <input type="text" class="form-input" id="setting-lock-msg" value="${escapeAttr(tenant?.default_lock_message || "This screen has been locked by an administrator. Please wait.")}">
            </div>
            <button type="submit" class="btn btn-primary">Save Profile Settings</button>
          </form>
        </div>

        <!-- Card 4: Kiosk Routing & Home Page -->
        <div class="card" id="section-routing">
          <h2 class="card-title">Kiosk Routing &amp; Home URL</h2>
          <p class="card-sub">Choose where workstations navigate upon boot and when resetting.</p>

          <form id="form-routing-settings">
            <div class="form-group">
              <label class="form-label" for="setting-home-route">Default Landing Path</label>
              <select class="form-select" id="setting-home-route">
                <option value="/" ${homeRoute === "/" ? "selected" : ""}>/ &mdash; the organization homepage</option>
                <option value="/home" ${homeRoute === "/home" ? "selected" : ""}>/home &mdash; straight to the app grid</option>
              </select>
              <div class="form-hint">Where a workstation lands on start-up and on Reset to Portal. The homepage is a page your organization writes; the app grid is the launcher users pick a site from.</div>
            </div>
            <button type="submit" class="btn btn-secondary">Save Routing</button>
          </form>
        </div>
      </div>
    </div>

    <!-- ============================================================== -->
    <!-- TAB 2: DOMAINS & CONNECTIVITY                                  -->
    <!-- ============================================================== -->
    <div class="tab-pane" id="pane-domains">
      <div class="grid-2col">
        <div class="stack-cards">
          <!-- Card 2: Subdomain Customization -->
          <div class="card" id="section-subdomain">
            <h2 class="card-title">Organization Subdomain Customization</h2>
            <p class="card-sub">Customize your organization's unique address on <code>${escapeHtml(baseDomain)}</code>.</p>

            <form id="form-subdomain-settings">
              <div class="form-group">
                <label class="form-label" for="setting-subdomain">Subdomain Slug</label>
                <div class="form-row">
                  <input type="text" class="form-input" id="setting-subdomain" value="${escapeAttr(currentSubdomain)}" required pattern="[a-zA-Z0-9-]{3,63}">
                  <span class="input-suffix">.${escapeHtml(baseDomain)}</span>
                </div>
                <div class="form-hint text-warning">Changing your subdomain takes effect immediately. Previously enrolled thin clients will need to be updated with the new address.</div>
              </div>
              <button type="submit" class="btn btn-secondary">Update Subdomain</button>
            </form>
          </div>

          <!-- Card 5: VNC & Remote Control Tunnel -->
          <div class="card" id="section-vnc">
            <h2 class="card-title">Remote Control &amp; VNC Tunnel</h2>
            <p class="card-sub">Cloudflare Tunnel hostname for live remote screen control.</p>

            <form id="form-tunnel-settings">
              <div class="form-group">
                <label class="form-label" for="setting-tunnel-domain">Tunnel Domain</label>
                <input type="text" class="form-input" id="setting-tunnel-domain" value="${escapeAttr(tunnelDomain)}" placeholder="e.g. remote.example.com">
                <div class="form-hint">Thin clients forward loopback noVNC port 6080 to this tunnel egress domain.</div>
              </div>
              <button type="submit" class="btn btn-secondary">Update Tunnel Domain</button>
            </form>
          </div>
        </div>

        <div>
          <!-- Card 3: Custom Domain -->
          <div class="card" id="section-custom-domain">
            <h2 class="card-title">White-Label Custom Domain</h2>
            <p class="card-sub">Point your own domain (e.g. <code>kiosk.example.com</code>) at this organization's console.</p>

            ${
              customDomain && customDomainStatus === "approved"
                ? `
                <div class="callout callout-success">
                  <div>
                    <span class="badge badge-green">Active domain</span>
                    <div class="callout-value mono">https://${escapeHtml(customDomain)}</div>
                  </div>
                </div>
                <button type="button" class="btn btn-danger" id="btn-disconnect-custom">Disconnect Custom Domain</button>
              `
                : customDomainStatus === "pending"
                ? `
                <div class="callout callout-warning">
                  <div>
                    <span class="badge badge-yellow">Pending platform approval</span>
                    <div class="callout-value mono">${escapeHtml(tenant?.requested_custom_domain || "")}</div>
                  </div>
                </div>
                <button type="button" class="btn btn-secondary" id="btn-cancel-custom">Cancel Request</button>
              `
                : `
                <form id="form-custom-domain">
                  <div class="form-group">
                    <label class="form-label" for="setting-custom-domain">Domain Name</label>
                    <input type="text" class="form-input" id="setting-custom-domain" placeholder="e.g. lab.example.com" required>
                    <div class="form-hint">Create a CNAME record in your DNS pointing to <code>${escapeHtml(baseDomain)}</code>, then submit below.</div>
                  </div>
                  <button type="submit" class="btn btn-secondary">Request Custom Domain</button>
                </form>
              `
            }
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================== -->
    <!-- TAB 3: ORGANIZATION HOMEPAGE                                         -->
    <!-- ============================================================== -->
    <div class="tab-pane" id="pane-homepage">
      <form id="form-homepage">
        <div class="grid-2col">
          <div class="card" id="section-homepage">
            <h2 class="card-title">Homepage Identity &amp; Welcome</h2>
            <p class="card-sub">The welcome page at <code>${escapeHtml(currentSubdomain)}.${escapeHtml(baseDomain)}/</code>.</p>

            <div class="form-group">
              <label class="form-label" for="homepage-headline">Headline</label>
              <input type="text" class="form-input" id="homepage-headline" maxlength="120" placeholder="${escapeAttr(tenant?.name || "Your organization")}" value="${escapeAttr(tenant?.homepage_headline || "")}">
            </div>
            <div class="form-group">
              <label class="form-label" for="homepage-intro">Introduction</label>
              <textarea class="form-textarea" id="homepage-intro" rows="3" maxlength="400" placeholder="One or two lines under the headline.">${escapeHtml(tenant?.homepage_intro || "")}</textarea>
            </div>

            <div class="form-actions">
              <button type="submit" class="btn btn-primary">Save Homepage</button>
              <a class="btn btn-secondary" href="/${tenantParam}" target="_blank" rel="noopener noreferrer">Preview &rarr;</a>
            </div>
          </div>

          <div class="card">
            <h2 class="card-title">Content Blocks</h2>
            <p class="card-sub">Notices, links to your own organization site, or user guidelines. Up to 12.</p>
            <div id="homepage-blocks"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-add-block">Add a block</button>
          </div>
        </div>
      </form>
    </div>

    <!-- ============================================================== -->
    <!-- TAB 4: SECURITY & AUDIT                                        -->
    <!-- ============================================================== -->
    <div class="tab-pane" id="pane-security">
      <div class="grid-2col">
        <div class="stack-cards">
          <!-- Card 6: Workstation Enrollment Key -->
          <div class="card" id="section-enrollment">
            <h2 class="card-title">Workstation Enrollment Key</h2>
            <p class="card-sub">Secret key used to securely pair thin clients to this organization.</p>

            <div class="secret-box">
              <code id="enrollment-key-display" class="secret-value">••••••••••••</code>
              <button type="button" class="btn btn-sm btn-secondary" id="btn-reveal-key">Reveal Key</button>
            </div>
            <button type="button" class="btn btn-danger btn-sm" id="btn-rotate-key">Rotate Enrollment Key</button>
          </div>

          <!-- Card 9: Account Password -->
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

        <div>
          <!-- Card 8: Recent Activity -->
          <div class="card" id="section-activity">
            <h2 class="card-title">Recent Activity</h2>
            <p class="card-sub">Privileged changes to this organization, including anything the platform did to it.</p>
            <div class="table-container table-scrollable">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody id="lab-audit-rows">
                  <tr><td colspan="3" class="table-empty">Loading\u2026</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSettingsScripts(nonce: string, blocks: HomepageBlock[]): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      // -------------------------------------------------------------
      // Tab Switching Logic
      // -------------------------------------------------------------
      const tabMap = {
        "section-general": "general",
        "section-routing": "general",
        "section-subdomain": "domains",
        "section-custom-domain": "domains",
        "section-vnc": "domains",
        "section-homepage": "homepage",
        "section-enrollment": "security",
        "section-password": "security",
        "section-activity": "security"
      };

      function switchTab(tabId) {
        const validTabs = ["general", "domains", "homepage", "security"];
        if (!validTabs.includes(tabId)) tabId = "general";

        // Update Subpanel Tabs
        const subBtns = document.querySelectorAll("#sub-tab-list .sub-action-item");
        subBtns.forEach((btn) => {
          btn.classList.toggle("active", btn.getAttribute("data-action") === "tab-" + tabId);
        });

        // Update Tab Panes
        const panes = document.querySelectorAll(".tab-pane");
        panes.forEach((pane) => {
          pane.classList.toggle("active", pane.id === "pane-" + tabId);
        });

        // Sync URL search param without reload
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("tab", tabId);
          window.history.replaceState({}, "", url.toString());
        } catch (_) {}
      }

      window.labkioskSwitchTab = switchTab;

      // Initialize from hash or URL query param
      const hash = window.location.hash.replace("#", "");
      const tabFromHash = tabMap[hash];
      const initialTab = tabFromHash || new URLSearchParams(window.location.search).get("tab") || "general";
      switchTab(initialTab);
      document.getElementById("form-profile-settings").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("setting-organization-name").value.trim();
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
          title: "Move the organization to '" + subdomain + "'?",
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
            message: "The organization goes back to its subdomain address. Workstations enrolled against the custom domain will need reconfiguring.",
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

      // ------------------------------------------------------ organization homepage
      // The block list is seeded from the server and edited entirely in the DOM;
      // it is posted back whole. escapeJson, because a block carries whatever
      // text the organization typed.
      const homepageBlocks = ${escapeJson(blocks)};
      const blocksHost = document.getElementById("homepage-blocks");

      function blockRow(block) {
        const row = document.createElement("div");
        row.className = "homepage-block-row";

        const title = document.createElement("input");
        title.type = "text";
        title.className = "form-input";
        title.placeholder = "Title";
        title.maxLength = 120;
        title.value = block.title || "";

        const body = document.createElement("textarea");
        body.className = "form-textarea";
        body.rows = 2;
        body.placeholder = "What this block says";
        body.maxLength = 600;
        body.value = block.body || "";

        const url = document.createElement("input");
        url.type = "url";
        url.className = "form-input";
        url.placeholder = "Optional link (https://...)";
        url.value = block.url || "";

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn btn-danger btn-sm";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => row.remove());

        row.append(title, body, url, remove);
        return row;
      }

      function readBlocks() {
        return Array.from(blocksHost ? blocksHost.children : []).map((row) => ({
          title: row.children[0].value,
          body: row.children[1].value,
          url: row.children[2].value
        }));
      }

      if (blocksHost) {
        for (const block of homepageBlocks) blocksHost.appendChild(blockRow(block));
      }

      const btnAddBlock = document.getElementById("btn-add-block");
      if (btnAddBlock && blocksHost) {
        btnAddBlock.addEventListener("click", () => {
          if (blocksHost.children.length >= 12) {
            lkToast("A homepage can hold 12 blocks.", "warning");
            return;
          }
          const row = blockRow({});
          blocksHost.appendChild(row);
          row.children[0].focus();
        });
      }

      const homepageForm = document.getElementById("form-homepage");
      if (homepageForm) {
        homepageForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            const res = await fetch(labkioskApi("/api/tenant/homepage"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                headline: document.getElementById("homepage-headline").value,
                intro: document.getElementById("homepage-intro").value,
                blocks: readBlocks()
              })
            });
            const data = await res.json();
            if (data.status === "ok") {
              lkToast("Homepage saved. " + data.blocks.length + " block(s) published.", "success");
            } else {
              lkToast(data.error || "Could not save the homepage", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

      const labAuditRows = document.getElementById("lab-audit-rows");
      if (labAuditRows) {
        (async function loadLabActivity() {
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
            const res = await fetch(labkioskApi("/api/audit-logs?limit=60"));
            const data = await res.json();
            const logs = Array.isArray(data.logs) ? data.logs : [];
            labAuditRows.replaceChildren();
            if (!logs.length) {
              labAuditRows.appendChild(placeholder("Nothing recorded for this organization yet."));
              return;
            }
            for (const entry of logs) {
              const row = document.createElement("tr");

              const when = document.createElement("td");
              when.className = "mono text-xs nowrap";
              const date = new Date(entry.created_at * 1000);
              // The viewer's own clock, not UTC: an administrator in IST reading
              // "13:44" for something done at 19:14 has been misled.
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
              const removes = /suspend|reject|delete|remove|revoke|rotate/.test(entry.action);
              const grants = /approve|reactivate|create|add/.test(entry.action);
              badge.className = "badge " + (removes ? "badge-red" : grants ? "badge-green" : "badge-blue");
              // textContent throughout: details carries operator names, domains
              // and URLs that arrived from the console.
              badge.textContent = entry.action;
              action.appendChild(badge);
              row.appendChild(action);

              const detail = document.createElement("td");
              detail.className = "text-muted text-xs cell-detail";
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
