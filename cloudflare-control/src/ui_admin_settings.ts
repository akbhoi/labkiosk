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
import { renderTwoFactorPaneHtml, renderTwoFactorScript } from "./ui_two_factor";
import { renderUpdatesPaneHtml, renderUpdatesScript } from "./ui_admin_updates";

export function buildSettingsPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, staff, tenantParam, baseDomain, nonce } = options;
  const canUpdate = options.canUpdate === true;
  if (options.accountOnly) {
    // No `settings` permission: the account's own sign-in, and nothing of the organization's.
    return {
      title: "Settings",
      contentHtml: `
    <div class="page-head">
      <div>
        <h1 class="page-title">Two-factor sign-in</h1>
        <p class="page-desc">How your own account signs in. The organization's settings belong to its administrators.</p>
      </div>
    </div>
${renderTwoFactorPaneHtml()}
${canUpdate ? renderUpdatesPaneHtml() : ""}`,
      scriptsHtml: renderTwoFactorScript(nonce) + (canUpdate ? renderUpdatesScript(nonce) : "")
    };
  }
  return {
    title: "Settings & Configuration",
    contentHtml: renderSettingsPageHtml(tenant, config, baseDomain, tenantParam, canUpdate),
    scriptsHtml:
      renderSettingsScripts(nonce, parseHomepageBlocks(tenant?.homepage_blocks)) +
      renderTwoFactorScript(nonce) +
      (canUpdate ? renderUpdatesScript(nonce) : "")
  };
}

function renderSettingsPageHtml(
  tenant: Tenant | undefined,
  config: LabConfig | undefined,
  baseDomain: string,
  tenantParam: string,
  canUpdate: boolean
): string {
  const currentSubdomain = tenant?.subdomain || "";
  const customDomain = tenant?.custom_domain || "";
  const customDomainStatus = tenant?.custom_domain_status || "none";
  const homeRoute = tenant?.home_route || "/home";

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Settings</h1>
        <p class="page-desc">Organization profile, kiosk behaviour, addresses, the homepage, and security.</p>
      </div>
      <a href="/${tenantParam}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Preview Organization Homepage
      </a>
    </div>

    <nav class="segmented-nav" aria-label="Settings Navigation">
      <button type="button" class="segmented-tab active" data-action="tab-general">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>General &amp; Kiosk</span>
      </button>
      <button type="button" class="segmented-tab" data-action="tab-domains">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <span>Domains &amp; Network</span>
      </button>
      <button type="button" class="segmented-tab" data-action="tab-homepage">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        <span>Organization Homepage</span>
      </button>
      <button type="button" class="segmented-tab" data-action="tab-security">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span>Security &amp; Audit</span>
      </button>
      <button type="button" class="segmented-tab" data-action="tab-two-factor">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
        <span>Two-factor sign-in</span>
      </button>
      <button type="button" class="segmented-tab" data-action="tab-issues">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>Errors &amp; Warnings</span>
      </button>${
        canUpdate
          ? `
      <button type="button" class="segmented-tab" data-action="tab-updates">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>Updates</span>
      </button>`
          : ""
      }
    </nav>

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
${renderRemoteControlCard(tenant)}
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
            <p class="card-sub">Secret key used to securely pair workstations to this organization.</p>

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
                  </tr>
                </thead>
                <tbody id="lab-audit-rows">
                  <tr><td colspan="2" class="table-empty">Loading\u2026</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================== -->
    <!-- TAB: TWO-FACTOR SIGN-IN (the signed-in account's own)          -->
    <!-- ============================================================== -->
    <div class="tab-pane" id="pane-two-factor">
${renderTwoFactorPaneHtml()}
    </div>

${
  canUpdate
    ? `    <div class="tab-pane" id="pane-updates">
${renderUpdatesPaneHtml()}
    </div>
`
    : ""
}
    <!-- ============================================================== -->
    <!-- TAB 5: ERRORS & WARNINGS                                       -->
    <!-- ============================================================== -->
    <div class="tab-pane" id="pane-issues">
      <div class="card" id="section-issues">
        <h2 class="card-title">Errors &amp; Warnings</h2>
        <p class="card-sub">Problems workstations reported, such as a system update that failed its first start and was rolled back. Kept for 90 days.</p>
        <div class="form-group" id="bug-report-optin" hidden>
          <label class="form-checkbox-label">
            <input type="checkbox" class="form-checkbox" id="bug-reports-enabled">
            <span>Send automatic bug reports</span>
          </label>
          <div id="bug-reports-terms-row" hidden>
            <label class="form-checkbox-label">
              <input type="checkbox" class="form-checkbox" id="bug-reports-terms">
              <span>I accept the <a href="/terms/bug-reports" target="_blank" rel="noopener noreferrer">Automatic Bug Report Terms</a> for this organization</span>
            </label>
          </div>
          <p class="form-hint" id="bug-reports-hint"></p>
        </div>
        <div class="table-container table-scrollable">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Workstation</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody id="workstation-issue-rows">
              <tr><td colspan="3" class="table-empty">Loading\u2026</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

/**
 * Remote Control is an add-on the platform approves per organization. This card
 * says where the organization stands and, until it is on, lets it ask.
 */
function renderRemoteControlCard(tenant: Tenant | undefined): string {
  const status = tenant?.remote_control_status || "none";
  const badges: Record<string, string> = {
    none: `<span class="badge badge-neutral">Not enabled</span>`,
    pending: `<span class="badge badge-yellow">Requested</span>`,
    approved: `<span class="badge badge-green">Enabled</span>`,
    rejected: `<span class="badge badge-red">Not approved</span>`
  };
  const explanation: Record<string, string> = {
    none: "See and control a workstation's screen from this console. It is enabled for each organization on request; we will email you the outcome, and licensing may need to be arranged first.",
    pending: "Your request is being reviewed. We will email you as soon as it has been decided.",
    approved: "Operators with the Workstations permission can open Remote Control on any connected workstation.",
    rejected: "Your last request was not approved. You can ask again, ideally with a note on what you need it for."
  };
  const canRequest = status === "none" || status === "rejected";
  return `
      <div class="card mt-lg" id="section-remote-control">
        <div class="row-between">
          <h2 class="card-title">Remote Control</h2>
          ${badges[status] || badges.none}
        </div>
        <p class="card-sub">${explanation[status] || explanation.none}</p>
        ${
          canRequest
            ? `<form id="form-remote-control-request" class="form-narrow">
          <div class="form-group">
            <label class="form-label" for="remote-control-reason">What will you use it for? (optional)</label>
            <textarea class="form-textarea" id="remote-control-reason" rows="3" maxlength="2000" placeholder="For example: helping users at 30 workstations across two sites."></textarea>
          </div>
          <button type="submit" class="btn btn-primary">Request Remote Control</button>
        </form>`
            : ""
        }
      </div>`;
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
        "section-homepage": "homepage",
        "section-enrollment": "security",
        "section-password": "security",
        "section-activity": "security",
        "section-issues": "issues",
        "section-updates": "updates"
      };

      function switchTab(tabId) {
        const validTabs = ["general", "domains", "homepage", "security", "two-factor", "issues"];
        if (document.getElementById("pane-updates")) validTabs.push("updates");
        if (!validTabs.includes(tabId)) tabId = "general";

        // Update In-Canvas Segmented Tabs
        const segTabs = document.querySelectorAll(".segmented-nav .segmented-tab");
        segTabs.forEach((tab) => {
          tab.classList.toggle("active", tab.getAttribute("data-action") === "tab-" + tabId);
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
        } catch (err) {
          console.warn("Could not record the tab in the address:", err);
        }
      }

      window.labkioskSwitchTab = switchTab;

      // In-Canvas Segmented Tabs Click Listener
      const segNav = document.querySelector(".segmented-nav");
      if (segNav) {
        segNav.addEventListener("click", function(e) {
          const tab = e.target && e.target.closest ? e.target.closest(".segmented-tab") : null;
          if (!tab) return;
          const action = tab.getAttribute("data-action");
          if (action && action.startsWith("tab-")) {
            e.preventDefault();
            switchTab(action.slice(4));
          }
        });
      }

      const remoteControlForm = document.getElementById("form-remote-control-request");
      if (remoteControlForm) {
        remoteControlForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const reason = document.getElementById("remote-control-reason").value.trim();
          try {
            const res = await fetch(labkioskApi("/api/tenant/remote-control/request"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason })
            });
            const data = await res.json();
            if (res.ok && data.status === "ok") {
              lkToastAfterReload("Remote Control requested. We will email you when it has been reviewed.", "success");
              window.location.reload();
            } else {
              lkToast(data.error || "The request could not be sent", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

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
            loadLabActivity();
          } else {
            lkToast(data.error || "Failed to save routing", "error");
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
            loadLabActivity();
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
              // Show what was saved: empty blocks are dropped and unsafe links cleared.
              if (blocksHost && Array.isArray(data.blocks)) blocksHost.replaceChildren(...data.blocks.map(blockRow));
              loadLabActivity();
            } else {
              lkToast(data.error || "Could not save the homepage", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

      const issueRows = document.getElementById("workstation-issue-rows");
      if (issueRows) {
        (async function loadWorkstationIssues() {
          function placeholder(text) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 3;
            cell.className = "table-empty";
            cell.textContent = text;
            row.appendChild(cell);
            return row;
          }
          const labels = {
            update_failed: "Update failed",
            update_rolled_back: "Update rolled back",
            boot_fallback: "Started a fallback image",
            boot_error: "Boot record error"
          };
          const pad = (n) => String(n).padStart(2, "0");
          // Where a sent problem stands: the issue it opened or joined, and that issue's status on GitHub.
          const reportStatus = {
            open: null,
            in_progress: ["In progress", "badge-blue"],
            pr_open: ["PR created", "badge-blue"],
            resolved: ["Resolved", "badge-green"],
            closed: ["Closed", "badge-neutral"]
          };
          function externalLink(href, text) {
            const link = document.createElement("a");
            link.href = href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = text;
            return link;
          }
          function bugReportLine(issue) {
            const line = document.createElement("div");
            line.className = "cell-sub";
            const number = typeof issue.issue_number === "number" ? " #" + issue.issue_number : "";
            line.appendChild(externalLink(issue.issue_url,
              (issue.report_match === "existing" ? "Already reported" : "New bug report") + number));
            const status = reportStatus[issue.report_status];
            if (status) {
              line.appendChild(document.createTextNode(" "));
              const badge = document.createElement("span");
              badge.className = "badge " + status[1];
              badge.textContent = status[0];
              line.appendChild(badge);
            }
            if (issue.report_status === "pr_open" && typeof issue.pr_url === "string" &&
                issue.pr_url.startsWith("https://github.com/")) {
              line.appendChild(document.createTextNode(" "));
              line.appendChild(externalLink(issue.pr_url, "View PR"));
            }
            return line;
          }
          const optIn = document.getElementById("bug-report-optin");
          const optInBox = document.getElementById("bug-reports-enabled");
          const termsRow = document.getElementById("bug-reports-terms-row");
          const termsBox = document.getElementById("bug-reports-terms");
          const optInHint = document.getElementById("bug-reports-hint");
          let bugState = null;
          function bugReportsAvailable() {
            return !!bugState && bugState.available === true && typeof bugState.repository === "string";
          }
          function termsCurrent() {
            return !!bugState && bugState.acceptedTermsVersion === bugState.termsVersion;
          }
          function showBugReportOptIn(state) {
            if (!optIn || !optInBox || !termsRow || !termsBox || !optInHint || !state) return;
            bugState = state;
            optIn.hidden = false;
            optInBox.checked = state.enabled === true;
            // Turning it off stays possible; turning it on needs the platform set up.
            optInBox.disabled = !bugReportsAvailable() && !optInBox.checked;
            const needsTerms = bugReportsAvailable() && !(state.enabled === true && termsCurrent());
            termsRow.hidden = !needsTerms;
            termsBox.checked = false;
            if (!bugReportsAvailable()) {
              optInHint.textContent = "Automatic bug reports are not set up on this platform.";
            } else if (state.enabled === true && !termsCurrent()) {
              optInHint.textContent = "The Automatic Bug Report Terms have changed. Nothing is sent until you accept version " +
                state.termsVersion + ".";
            } else if (state.enabled === true) {
              const accepted = state.termsAcceptedAt ? new Date(state.termsAcceptedAt * 1000) : null;
              optInHint.textContent = "Problems are filed as GitHub issues in " + state.repository +
                ", where anyone may be able to read them. Terms version " + state.acceptedTermsVersion +
                (!accepted || isNaN(accepted.getTime()) ? "" : " accepted on " + accepted.toLocaleDateString()) + ".";
            } else {
              optInHint.textContent = "New errors and warnings are filed as GitHub issues in " + state.repository +
                ", where anyone may be able to read them. A report carries the kind of problem, the system image version " +
                "and the problem text with network addresses, host names and identifiers removed; never this organization's " +
                "or its workstations' names. Problems listed before you turn this on are not sent.";
            }
          }
          async function saveBugReports(enabled) {
            const body = enabled ? { enabled, acceptTerms: bugState.termsVersion } : { enabled };
            const res = await fetch(labkioskApi("/api/settings/bug-reports"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok || data.status !== "ok") throw new Error(data.error || ("HTTP " + res.status));
            bugState.enabled = enabled;
            if (enabled) {
              bugState.acceptedTermsVersion = bugState.termsVersion;
              bugState.termsAcceptedAt = Math.floor(Date.now() / 1000);
            }
            loadLabActivity();
          }
          if (optInBox && termsBox) {
            optInBox.addEventListener("change", async () => {
              const enabled = optInBox.checked;
              if (enabled && !termsBox.checked) {
                optInBox.checked = false;
                lkToast("Accept the Automatic Bug Report Terms first.", "error");
                return;
              }
              optInBox.disabled = true;
              try {
                await saveBugReports(enabled);
                lkToast(enabled ? "Automatic bug reports turned on." : "Automatic bug reports turned off.", "success");
              } catch (err) {
                console.warn("Could not change automatic bug reports:", err);
                bugState.enabled = !enabled;
                lkToast("Could not change automatic bug reports: " + err.message, "error");
              } finally {
                showBugReportOptIn(bugState);
              }
            });
            termsBox.addEventListener("change", async () => {
              // Already on under older terms: ticking the box accepts the current ones.
              if (!termsBox.checked || !bugState || bugState.enabled !== true) return;
              termsBox.disabled = true;
              try {
                await saveBugReports(true);
                lkToast("Automatic Bug Report Terms accepted.", "success");
              } catch (err) {
                console.warn("Could not accept the Automatic Bug Report Terms:", err);
                lkToast("Could not accept the terms: " + err.message, "error");
              } finally {
                termsBox.disabled = false;
                showBugReportOptIn(bugState);
              }
            });
          }
          try {
            const res = await fetch(labkioskApi("/api/workstation-issues?limit=100"));
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            const issues = Array.isArray(data.issues) ? data.issues : [];
            showBugReportOptIn(data.bugReports);
            issueRows.replaceChildren();
            if (!issues.length) {
              issueRows.appendChild(placeholder("No errors or warnings reported."));
              return;
            }
            for (const issue of issues) {
              const row = document.createElement("tr");

              const when = document.createElement("td");
              when.className = "mono text-xs nowrap";
              // When the workstation recorded it; its clock is what the
              // operator standing at it would have seen.
              const date = new Date(issue.occurred_at * 1000);
              if (isNaN(date.getTime())) {
                when.textContent = "\u2014";
              } else {
                when.textContent = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
                  " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
                when.title = date.toISOString();
              }
              row.appendChild(when);

              const workstation = document.createElement("td");
              const name = document.createElement("div");
              name.className = "cell-title";
              name.textContent = issue.client_id;
              workstation.appendChild(name);
              if (issue.image_version) {
                const version = document.createElement("div");
                version.className = "cell-sub mono";
                version.textContent = issue.image_version;
                workstation.appendChild(version);
              }
              row.appendChild(workstation);

              const problem = document.createElement("td");
              const badge = document.createElement("span");
              badge.className = "badge " + (issue.severity === "error" ? "badge-red" : "badge-yellow");
              badge.textContent = labels[issue.kind] || issue.kind;
              problem.appendChild(badge);
              if (issue.details) {
                const detail = document.createElement("div");
                detail.className = "cell-sub cell-detail";
                detail.textContent = issue.details;
                problem.appendChild(detail);
              }
              if (issue.report_state === "sent" && typeof issue.issue_url === "string" &&
                  issue.issue_url.startsWith("https://github.com/")) {
                problem.appendChild(bugReportLine(issue));
              } else if (issue.report_state === "pending") {
                const report = document.createElement("div");
                report.className = "cell-sub";
                report.textContent = "Bug report queued";
                problem.appendChild(report);
              }
              row.appendChild(problem);

              issueRows.appendChild(row);
            }
          } catch (err) {
            console.warn("Could not load errors and warnings:", err);
            issueRows.replaceChildren();
            issueRows.appendChild(placeholder("Could not load errors and warnings."));
          }
        })();
      }

      const labAuditRows = document.getElementById("lab-audit-rows");
      // Settings actions are audited: each one that succeeds calls this again,
      // so the list shows it without a reload.
      async function loadLabActivity() {
        if (!labAuditRows) return;
        await (async function () {
          function placeholder(text) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 2;
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
              // The detail sits under its action: this card is too narrow for a
              // third column, which squeezed the detail out of view -- and a
              // failed update's reason is the part an administrator needs.
              if (entry.details) {
                const detail = document.createElement("div");
                detail.className = "cell-sub cell-detail";
                detail.textContent = entry.details;
                action.appendChild(detail);
              }
              row.appendChild(action);

              labAuditRows.appendChild(row);
            }
          } catch (err) {
            labAuditRows.replaceChildren();
            labAuditRows.appendChild(placeholder("Could not load recent activity."));
          }
        })();
      }
      loadLabActivity();

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
            loadLabActivity();
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
