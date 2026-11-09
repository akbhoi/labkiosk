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
import { allowsCustomDomain, CATALOGUE, entitlement } from "./plans";
import { parseHomepageBlocks } from "./db";
import { consoleSubdomain, nextAddressChangeAt, showsHomepage } from "./addresses";
import { escapeHtml, escapeAttr , escapeJson } from "./escape";
import { AdminPageInput, AdminPageParts, WHEN_PANE_SHOWN_JS } from "./ui_admin_shared";
import { buildAccountPage } from "./ui_admin_account";
import { renderUpdatesPaneHtml, renderUpdatesScript } from "./ui_admin_updates";
import { renderSsoCardHtml, renderSsoScript } from "./ui_admin_sso";
import { renderPowerPaneHtml, renderPowerScript } from "./ui_admin_power";
import { renderPrintingPaneHtml, renderPrintingScript } from "./ui_admin_printing";

export function buildSettingsPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, staff, tenantParam, baseDomain, nonce } = options;
  const canUpdate = options.canUpdate === true;
  if (options.accountOnly) {
    // No `settings` permission: the account's own sign-in, and nothing of the organization's.
    const account = buildAccountPage(options);
    return {
      title: account.title,
      contentHtml: account.contentHtml + (canUpdate ? renderUpdatesPaneHtml() : ""),
      scriptsHtml: account.scriptsHtml + (canUpdate ? renderUpdatesScript(nonce) : "")
    };
  }
  return {
    title: "Settings & Configuration",
    contentHtml: renderSettingsPageHtml(tenant, config, baseDomain, tenantParam, canUpdate),
    scriptsHtml:
      renderSettingsScripts(nonce, parseHomepageBlocks(tenant?.homepage_blocks)) +
      (canUpdate ? renderUpdatesScript(nonce) : "") +
      renderSsoScript(nonce) +
      renderPowerScript(nonce) +
      renderPrintingScript(nonce)
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
  const nextAddressChange = tenant ? nextAddressChangeAt(tenant, Math.floor(Date.now() / 1000)) : null;
  const homepageLive = tenant ? showsHomepage(tenant) : true;
  const shownSubdomain = tenant ? consoleSubdomain(tenant) : "";
  const customDomain = tenant?.custom_domain || "";
  const customDomainStatus = tenant?.custom_domain_status || "none";
  const certificate = tenant?.custom_hostname_status || "pending";
  const mayConnectDomain = tenant ? allowsCustomDomain(tenant) : false;
  const homeRoute = tenant?.home_route || "/home";

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Settings</h1>
        <p class="page-desc">Organization profile, kiosk behaviour, addresses, the homepage, security, updates and power.</p>
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
        <span>Security</span>
      </button>${
        canUpdate
          ? `
      <button type="button" class="segmented-tab" data-action="tab-updates">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>Updates</span>
      </button>`
          : ""
      }
      <button type="button" class="segmented-tab" data-action="tab-power">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
        <span>Power &amp; Printing</span>
      </button>
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
            <div class="form-group">
              <label class="form-checkbox-label">
                <input type="checkbox" class="form-checkbox" id="setting-home-reset" ${tenant?.home_reset === 0 ? "" : "checked"}>
                <span>Home starts a new session</span>
              </label>
              <div class="form-hint">Home in the kiosk bar asks &ldquo;Start over?&rdquo; and, on Yes, signs out of every site and clears the browser, as Clear Session does from the console. Turned off, Home only goes back to the landing page.</div>
            </div>
            <button type="submit" class="btn btn-secondary">Save Routing</button>
          </form>
        </div>
      </div>
${renderRemoteControlCard(tenant, tenantParam)}
    </div>

    <!-- ============================================================== -->
    <!-- TAB 2: DOMAINS & CONNECTIVITY                                  -->
    <!-- ============================================================== -->
    <div class="tab-pane" id="pane-domains">
      <div class="grid-2col">
        <div class="stack-cards">
          <!-- Card 2: Console address (src/addresses.ts) -->
          <div class="card" id="section-subdomain">
            <h2 class="card-title">Console Address</h2>
            <p class="card-sub">Your console is at <code>${escapeHtml(shownSubdomain)}.${escapeHtml(baseDomain)}</code>.${
              shownSubdomain !== currentSubdomain
                ? ` Earlier addresses, such as <code>${escapeHtml(currentSubdomain)}.${escapeHtml(baseDomain)}</code>, keep working, so enrolled workstations need no change.`
                : ""
            }</p>
            ${
              nextAddressChange
                ? `<p class="form-hint">The address can be changed once a week. The next change is possible on ${escapeHtml(new Date(nextAddressChange * 1000).toISOString().slice(0, 10))}.</p>`
                : `<form id="form-subdomain-settings">
              <div class="form-group">
                <label class="form-label" for="setting-subdomain">New address</label>
                <div class="form-row">
                  <input type="text" class="form-input" id="setting-subdomain" placeholder="greenwood" required minlength="3" maxlength="63" pattern="[a-z0-9]+(-+[a-z0-9]+)*" autocapitalize="none" spellcheck="false">
                  <span class="input-suffix">.${escapeHtml(baseDomain)}</span>
                </div>
                <div class="form-hint">Lowercase letters, numbers and hyphens. The address can be changed once a week, and the one you leave keeps working for your workstations. Your public homepage is at the root of a chosen address.</div>
              </div>
              <button type="submit" class="btn btn-secondary">Change Address</button>
            </form>`
            }
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
                <div class="callout ${certificate === "active" ? "callout-success" : certificate === "failed" ? "callout-danger" : "callout-warning"}">
                  <div>
                    ${
                      mayConnectDomain
                        ? ""
                        : `<div class="form-hint">This domain is not loading: your plan no longer includes a custom domain. <a href="/admin/plan${escapeAttr(tenantParam)}#plans">Add it on Plan &amp; billing</a> and it works again.</div>`
                    }
                    <span class="badge ${certificate === "active" ? "badge-green" : certificate === "failed" ? "badge-red" : "badge-yellow"}">${
                      certificate === "active" ? "Active domain" : certificate === "failed" ? "Certificate failed" : "Waiting for DNS"
                    }</span>
                    <div class="callout-value mono">https://${escapeHtml(customDomain)}</div>
                    ${
                      certificate === "active"
                        ? ""
                        : `<div class="form-hint">${
                            certificate === "failed"
                              ? "Cloudflare could not issue the certificate. Check the CNAME record, then disconnect and connect the domain again."
                              : `Cloudflare issues the certificate once a CNAME record for this domain points to <code>${escapeHtml(baseDomain)}</code>. That can take a few minutes after the record is in place.`
                          }</div>`
                    }
                  </div>
                </div>
                <button type="button" class="btn btn-danger" id="btn-disconnect-custom">Disconnect Custom Domain</button>
              `
                : !mayConnectDomain
                  ? `
                <p class="form-hint">A custom domain is included in Pro and Custom, and an add-on on Starter, Standard and Education for ₹${CATALOGUE.standard.domainMonthly.toLocaleString("en-IN")} a month or ₹${CATALOGUE.standard.domainYearly.toLocaleString("en-IN")} a year. Without it, your console address is yours, and you can change it once a week.</p>
                <a class="btn btn-secondary" href="/admin/plan${escapeAttr(tenantParam)}#plans">Add a custom domain</a>
              `
                  : `
                <form id="form-custom-domain">
                  <div class="form-group">
                    <label class="form-label" for="setting-custom-domain">Domain Name</label>
                    <input type="text" class="form-input" id="setting-custom-domain" placeholder="e.g. lab.example.com" required>
                    <div class="form-hint">Create a CNAME record in your DNS pointing to <code>${escapeHtml(baseDomain)}</code>, then connect it. The domain works once Cloudflare has issued its certificate.</div>
                  </div>
                  <button type="submit" class="btn btn-secondary">Connect Custom Domain</button>
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
            <p class="card-sub">The welcome page at <code>${escapeHtml(shownSubdomain)}.${escapeHtml(baseDomain)}/</code>. What you publish here follows the <a href="/content-policy" target="_blank" rel="noopener noreferrer">Content Policy</a>.</p>
            ${homepageLive ? "" : `<p class="form-hint text-warning" id="homepage-not-live">The homepage goes live once your organization has a chosen address (Settings, Domains &amp; Network). Until then the address shows your User Portal. You can prepare it now.</p>`}

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
          <div class="card">
            <h2 class="card-title">Your own sign-in</h2>
            <p class="card-sub">Your password and two-factor sign-in are under My account; the organization's activity log is under Reports.</p>
            <div class="form-actions">
              <a class="btn btn-secondary btn-sm" href="/admin/account${escapeAttr(tenantParam)}">My account</a>
              <a class="btn btn-ghost btn-sm" href="/admin/reports${escapeAttr(tenantParam ? `${tenantParam}&tab=activity` : "?tab=activity")}">Activity log</a>
            </div>
          </div>
        </div>
        <div>
${renderSsoCardHtml()}
        </div>
      </div>
    </div>

${
  canUpdate
    ? `    <div class="tab-pane" id="pane-updates">
${renderUpdatesPaneHtml()}
    </div>
`
    : ""
}
    <div class="tab-pane" id="pane-power">
${renderPowerPaneHtml()}
      <div class="mt-lg" id="pane-printing-section">
${renderPrintingPaneHtml()}
      </div>
    </div>

  `;
}

/**
 * Remote Control is sold per workstation (src/limits.ts): this card says how
 * many seats the plan has and sends the organization to Plan & billing for
 * them. With seats it is on, or turned on here; nobody approves it.
 */
function renderRemoteControlCard(tenant: Tenant | undefined, tenantParam: string): string {
  const revoked = tenant?.remote_control_status === "rejected" && Boolean(tenant?.remote_control_revoked_at);
  const seats = tenant ? entitlement(tenant).remoteSeats : 0;
  const status = revoked ? "revoked" : seats < 1 ? "none" : tenant?.remote_control_status === "approved" ? "seats" : "off";
  const badges: Record<string, string> = {
    none: `<span class="badge badge-neutral">Add-on</span>`,
    off: `<span class="badge badge-neutral">Off</span>`,
    seats: `<span class="badge badge-green">Enabled</span>`,
    revoked: `<span class="badge badge-red">Turned off</span>`
  };
  const revokedOn = revoked ? new Date(Number(tenant!.remote_control_revoked_at) * 1000).toISOString().slice(0, 10) : "";
  const seatText = `${seats} Remote Control ${seats === 1 ? "seat" : "seats"}`;
  const explanation: Record<string, string> = {
    none: `See and control a workstation's screen from this console. Each workstation you want to reach needs a Remote Control seat: ${escapeHtml(`₹${CATALOGUE.standard.remoteMonthly}`)} a month, and ${CATALOGUE.pro.label} includes ${CATALOGUE.pro.includedRemoteSeats}.`,
    off: `Your plan has ${seatText}, and Remote Control is off. Turn it on to open a connected workstation's screen from Workstations.`,
    seats: `Your plan has ${seatText}. A workstation takes a free seat the first time an administrator opens it; choose which workstations hold them, or buy more, on Plan &amp; billing.`,
    revoked: `Lab Kiosk turned Remote Control off for this organization on ${escapeHtml(revokedOn)}. Write to support to have it turned on again.`
  };
  const actions =
    status === "revoked"
      ? ""
      : `<div class="form-actions">${status === "off" ? `<button type="button" class="btn btn-primary" id="btn-remote-control-enable">Turn on Remote Control</button>` : ""}<a class="btn btn-secondary" href="/admin/plan${escapeAttr(tenantParam)}">${status === "none" ? "Buy seats" : "Manage seats"} on Plan &amp; billing</a></div>`;
  return `
      <div class="card mt-lg" id="section-remote-control">
        <div class="row-between">
          <h2 class="card-title">Remote Control</h2>
          ${badges[status]}
        </div>
        <p class="card-sub">${explanation[status]}</p>
        ${actions}
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
        "section-sso": "security",
        "section-updates": "updates",
        "section-power": "power",
        "section-printing": "power"
      };

      function switchTab(tabId) {
        // The tabs are the panes this page rendered: Updates only for the \`updates\` permission.
        const validTabs = Array.from(document.querySelectorAll(".tab-pane[id^='pane-']")).map((pane) => pane.id.slice(5));
        if (!validTabs.includes(tabId)) tabId = "general";

        // Update In-Canvas Segmented Tabs
        const segTabs = document.querySelectorAll(".segmented-nav .segmented-tab");
        segTabs.forEach((tab) => {
          const active = tab.getAttribute("data-action") === "tab-" + tabId;
          tab.classList.toggle("active", active);
          // The tabs scroll sideways on a narrow screen; keep the chosen one in sight.
          if (active && typeof tab.scrollIntoView === "function") tab.scrollIntoView({ block: "nearest", inline: "nearest" });
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

      const remoteControlEnable = document.getElementById("btn-remote-control-enable");
      if (remoteControlEnable) {
        remoteControlEnable.addEventListener("click", async () => {
          try {
            const res = await fetch(labkioskApi("/api/tenant/remote-control/enable"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}"
            });
            const data = await res.json();
            if (res.ok && data.status === "ok") {
              lkToastAfterReload("Remote Control is on.", "success");
              window.location.reload();
            } else {
              lkToast(data.error || "Remote Control could not be turned on", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

      const remoteControlDisable = document.getElementById("btn-remote-control-disable");
      if (remoteControlDisable) {
        remoteControlDisable.addEventListener("click", async () => {
          const ok = await lkConfirm({
            title: "Turn off Remote Control?",
            message: "Every Remote Control session open now ends. You can turn it on again here.",
            confirmLabel: "Turn off",
            tone: "danger"
          });
          if (!ok) return;
          try {
            const res = await fetch(labkioskApi("/api/tenant/remote-control/disable"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}"
            });
            const data = await res.json();
            if (res.ok && data.status === "ok") {
              lkToastAfterReload("Remote Control is off.", "success");
              window.location.reload();
            } else {
              lkToast(data.error || "Remote Control could not be turned off", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

      // Initialize from hash or URL query param
      const hash = window.location.hash.replace("#", "");
      const tabFromHash = tabMap[hash];
      // Printing shares the Power tab; an older link to it still opens there.
      const askedTab = new URLSearchParams(window.location.search).get("tab");
      const initialTab = tabFromHash || (askedTab === "printing" ? "power" : askedTab) || "general";
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

      const subdomainForm = document.getElementById("form-subdomain-settings");
      if (subdomainForm) subdomainForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const subdomain = document.getElementById("setting-subdomain").value.trim().toLowerCase();
        try {
          const res = await fetch(labkioskApi("/api/tenant/subdomain"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subdomain })
          });
          const data = await res.json();
          if (res.ok && data.status === "ok") {
            // Sessions belong to one host: the console opens at the new address, signed in there anew.
            lkToastAfterReload("Address changed. Sign in at the new address.", "success");
            window.location.assign(data.consoleUrl);
          } else {
            lkToast(data.error || "The address could not be changed", "error");
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
              lkToastAfterReload("Custom domain connected. It works once its certificate is issued.", "success");
              window.location.reload();
            } else {
              lkToast(data.error || "The custom domain could not be connected", "error");
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

      document.getElementById("form-routing-settings").addEventListener("submit", async (e) => {
        e.preventDefault();
        const homeRoute = document.getElementById("setting-home-route").value;
        const homeReset = document.getElementById("setting-home-reset").checked;
        try {
          const res = await fetch(labkioskApi("/api/tenant/settings"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ homeRoute, homeReset })
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
              // Show what was saved: empty blocks are dropped and unsafe links cleared.
              if (blocksHost && Array.isArray(data.blocks)) blocksHost.replaceChildren(...data.blocks.map(blockRow));
            } else {
              lkToast(data.error || "Could not save the homepage", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

${WHEN_PANE_SHOWN_JS}
    </script>
  `;
}
