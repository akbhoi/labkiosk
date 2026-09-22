/**
 * The Apps & Web management console: unified control for Lesson Broadcast,
 * Student Learning Portal application cards, and the Chromium Domain Allowlist firewall.
 *
 * Consolidates the previously separate /admin/broadcast, /admin/portal, and
 * /admin/whitelist modules into a cohesive tabbed experience.
 */

import { Tenant, PortalSite, BroadcastPreset, LabConfig } from "./types";
import { escapeHtml, escapeAttr, safeHttpUrl } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildAppsWebPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, tenantParam, nonce } = options;
  return {
    title: "Apps & Web Control",
    contentHtml: renderAppsWebContentHtml(tenant, config, sites, presets, tenantParam),
    scriptsHtml: renderAppsWebScripts(nonce),
    subPanelTitle: "Apps & Web",
    subPanelSubtitle: "Curriculum & domain control",
    subPanelHtml: renderAppsWebSubPanelHtml(tenant, config, sites, presets, tenantParam)
  };
}

function renderAppsWebSubPanelHtml(
  tenant: Tenant | undefined,
  config: LabConfig,
  sites: PortalSite[],
  presets: BroadcastPreset[],
  tenantParam: string
): string {
  const activeUrl = tenant?.broadcast_url;
  return `
    <div class="sub-section-title">Navigation Views</div>
    <div class="sub-action-list" id="sub-tab-list">
      <button type="button" class="sub-action-item active" data-action="tab-broadcast">
        <span style="display: flex; align-items: center; gap: 8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.93 4.93a10 10 0 0 1 14.14 0"/><path d="M7.76 7.76a6 6 0 0 1 8.48 0"/><circle cx="12" cy="12" r="2"/></svg>
          Lesson Broadcast
        </span>
      </button>
      <button type="button" class="sub-action-item" data-action="tab-portal">
        <span style="display: flex; align-items: center; gap: 8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          Student Portal
        </span>
        <span class="sub-action-badge">${sites.length}</span>
      </button>
      <button type="button" class="sub-action-item" data-action="tab-whitelist">
        <span style="display: flex; align-items: center; gap: 8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Domain Allowlist
        </span>
        <span class="sub-action-badge">${config.whitelist.length}</span>
      </button>
    </div>

    <!-- Broadcast Context Tools -->
    <div data-tab-content="broadcast">
      <div class="sub-section-title" style="margin-top: 14px;">Active Lesson Status</div>
      <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); margin-bottom: 12px;">
        <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase;">Current Broadcast URL</div>
        <div style="font-size: 12px; font-weight: 700; color: #93c5fd; margin-top: 4px; word-break: break-all; font-family: 'JetBrains Mono', monospace;" id="sub-active-url">${escapeHtml(activeUrl || "None (Student Portal Active)")}</div>
      </div>
      <div class="sub-action-list">
        <button type="button" class="sub-action-item" id="sub-btn-reset-portal" data-action="quick-reset-portal">
          <span style="display: flex; align-items: center; gap: 8px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            Clear / Release to Portal
          </span>
        </button>
      </div>

      <div class="sub-section-title" style="margin-top: 14px;">Quick Presets</div>
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
    </div>

    <!-- Portal Context Tools -->
    <div data-tab-content="portal" style="display: none;">
      <div class="sub-section-title" style="margin-top: 14px;">Portal Actions</div>
      <div class="sub-action-list">
        <button type="button" class="sub-action-item" data-focus="app-title">
          <span style="display: flex; align-items: center; gap: 8px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add App Card
          </span>
        </button>
        <a href="/home${tenantParam}" target="_blank" rel="noopener noreferrer" class="sub-action-item">
          <span style="display: flex; align-items: center; gap: 8px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Preview Student Portal
          </span>
        </a>
      </div>

      <div class="sub-section-title" style="margin-top: 14px;">Portal Summary</div>
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
    </div>

    <!-- Allowlist Context Tools -->
    <div data-tab-content="whitelist" style="display: none;">
      <div class="sub-section-title" style="margin-top: 14px;">Firewall Actions</div>
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
    </div>
  `;
}

function renderAppsWebContentHtml(
  tenant: Tenant | undefined,
  config: LabConfig,
  sites: PortalSite[],
  presets: BroadcastPreset[],
  tenantParam: string
): string {
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

  const portalCardsHtml = sites
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
          <div style="display: flex; gap: 8px; align-items: center;">
            <a href="${escapeAttr(safeHttpUrl(s.url) || "#")}" target="_blank" rel="noopener noreferrer" style="font-size: 12px; color: var(--accent); text-decoration: none;">Test Link &rarr;</a>
            <button type="button" class="btn btn-sm btn-secondary btn-launch-preset" data-url="${escapeAttr(s.url)}">Broadcast</button>
          </div>
          <button type="button" class="btn btn-sm btn-danger btn-delete-app" data-id="${escapeAttr(s.id)}">Remove</button>
        </div>
      </div>
    `)
    .join("");

  const domainTagsHtml = config.whitelist
    .map((d) => `
      <span class="domain-tag">
        <span>${escapeHtml(d)}</span>
        <button type="button" class="btn-remove-domain" data-domain="${escapeAttr(d)}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 0 2px;">✕</button>
      </span>
    `)
    .join("");

  return `
    <div class="page-head" style="margin-bottom: 20px;">
      <div>
        <h1 class="page-title">Apps &amp; Web Control</h1>
        <p class="page-desc">Manage curriculum applications, synchronize live broadcast lessons, and configure allowed web domains.</p>
      </div>
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
        <div class="segmented-nav" id="apps-web-tabs" role="tablist">
          <button type="button" class="segmented-tab active" data-tab="broadcast" role="tab" aria-selected="true" id="tab-btn-broadcast">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.93 4.93a10 10 0 0 1 14.14 0"/><path d="M7.76 7.76a6 6 0 0 1 8.48 0"/><circle cx="12" cy="12" r="2"/></svg>
            Lesson Broadcast
          </button>
          <button type="button" class="segmented-tab" data-tab="portal" role="tab" aria-selected="false" id="tab-btn-portal">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            Student Portal (${sites.length})
          </button>
          <button type="button" class="segmented-tab" data-tab="whitelist" role="tab" aria-selected="false" id="tab-btn-whitelist">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            Domain Allowlist (${config.whitelist.length})
          </button>
        </div>
        <a href="/home${tenantParam}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm" title="Preview Student Portal">
          Preview Student Portal &rarr;
        </a>
      </div>
    </div>

    <!-- ============================================================== -->
    <!-- TAB 1: LESSON BROADCAST                                       -->
    <!-- ============================================================== -->
    <div class="tab-pane active" id="pane-broadcast">
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

          <div class="card" style="margin-top: 20px;">
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
    </div>

    <!-- ============================================================== -->
    <!-- TAB 2: STUDENT PORTAL APPS                                    -->
    <!-- ============================================================== -->
    <div class="tab-pane" id="pane-portal">
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
              <div class="form-group">
                <label class="form-label" for="app-category">Category</label>
                <select class="form-select" id="app-category">
                  <option value="Computer Science">Computer Science</option>
                  <option value="Mathematics">Mathematics</option>
                  <option value="Sciences &amp; Physics">Sciences &amp; Physics</option>
                  <option value="Languages &amp; Literacy">Languages &amp; Literacy</option>
                  <option value="General Reference">General Reference</option>
                  <option value="Assessment &amp; Exams">Assessment &amp; Exams</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label" for="app-icon">Icon Emoji or Glyphs</label>
                <input type="text" class="form-input" id="app-icon" placeholder="🎨, 🧮, 🔬, 📚, 🌐" value="🌐">
              </div>
              <button type="submit" class="btn btn-primary">Add Application to Portal</button>
            </form>
          </div>
        </div>

        <div>
          <div class="card">
            <h2 class="card-title">Configured Portal Applications (${sites.length})</h2>
            <p class="card-sub">Click Test Link to preview or Broadcast to push directly to screens.</p>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; margin-top: 14px;" id="portal-apps-grid">
              ${portalCardsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No applications added yet. Use the form on the left to add one.</p>`}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================== -->
    <!-- TAB 3: DOMAIN ALLOWLIST FIREWALL                              -->
    <!-- ============================================================== -->
    <div class="tab-pane" id="pane-whitelist">
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
              <h2 class="card-title" style="margin-bottom: 0;">Currently Allowed Domains (${config.whitelist.length})</h2>
            </div>
            <p class="card-sub">These domains are merged into the Chromium URLAllowlist across all lab workstations.</p>

            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px;" id="whitelist-tags-container">
              ${domainTagsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No domains currently whitelisted.</p>`}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAppsWebScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function() {
        "use strict";

        // Tab Switching Logic
        function switchTab(tabId) {
          const validTabs = ["broadcast", "portal", "whitelist"];
          if (!validTabs.includes(tabId)) tabId = "broadcast";

          // Update Top Segmented Tabs
          const tabBtns = document.querySelectorAll("#apps-web-tabs .segmented-tab");
          tabBtns.forEach(btn => {
            const isMatch = btn.getAttribute("data-tab") === tabId;
            btn.classList.toggle("active", isMatch);
            btn.setAttribute("aria-selected", isMatch ? "true" : "false");
          });

          // Update Subpanel Tabs
          const subBtns = document.querySelectorAll("#sub-tab-list .sub-action-item");
          subBtns.forEach(btn => {
            btn.classList.toggle("active", btn.getAttribute("data-action") === "tab-" + tabId);
          });

          // Update Subpanel Content Sections
          const subContents = document.querySelectorAll("[data-tab-content]");
          subContents.forEach(el => {
            el.style.display = el.getAttribute("data-tab-content") === tabId ? "block" : "none";
          });

          // Update Tab Panes
          const panes = document.querySelectorAll(".tab-pane");
          panes.forEach(pane => {
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

        // Initialize Tab from URL
        const initialTab = new URLSearchParams(window.location.search).get("tab") || "broadcast";
        switchTab(initialTab);

        // Top tab click listeners
        document.querySelectorAll("#apps-web-tabs [data-tab]").forEach(btn => {
          btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
        });

        // -------------------------------------------------------------
        // Broadcast Form
        // -------------------------------------------------------------
        const broadcastForm = document.getElementById("broadcast-form");
        if (broadcastForm) {
          broadcastForm.addEventListener("submit", async (e) => {
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
                lkToast(data.error || "Broadcast failed", "error");
              }
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        }

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
                lkToast(data.error || "Failed to stop broadcast", "error");
              }
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        }

        // Launch preset buttons (cards and subpanel)
        document.querySelectorAll(".btn-launch-preset").forEach(btn => {
          btn.addEventListener("click", async () => {
            const url = btn.getAttribute("data-url");
            if (!url) return;
            const agreed = await lkConfirm({
              title: "Broadcast to all workstations?",
              message: "Synchronize all student displays to " + url + " immediately?",
              confirmLabel: "Broadcast Now",
              tone: "primary"
            });
            if (!agreed) return;
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
                lkToast(data.error || "Broadcast failed", "error");
              }
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        });

        // Add Preset Form
        const addPresetForm = document.getElementById("add-preset-form");
        if (addPresetForm) {
          addPresetForm.addEventListener("submit", async (e) => {
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
              if (data.status === "ok") {
                window.location.reload();
              } else {
                lkToast(data.error || "Failed to save preset", "error");
              }
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        }

        // Delete Preset Buttons
        document.querySelectorAll(".btn-delete-preset").forEach(btn => {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-id");
            if (!id) return;
            const agreed = await lkConfirm({
              title: "Delete preset bookmark?",
              message: "This shortcut will be removed permanently.",
              confirmLabel: "Delete",
              tone: "danger"
            });
            if (!agreed) return;
            try {
              const res = await fetch(labkioskApi("/api/broadcast-presets/" + encodeURIComponent(id)), {
                method: "DELETE"
              });
              const data = await res.json();
              if (data.status === "ok") {
                window.location.reload();
              } else {
                lkToast(data.error || "Failed to delete preset", "error");
              }
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        });

        // -------------------------------------------------------------
        // Portal Apps Management
        // -------------------------------------------------------------
        const addAppForm = document.getElementById("add-app-form");
        if (addAppForm) {
          addAppForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const title = document.getElementById("app-title").value.trim();
            const url = document.getElementById("app-url").value.trim();
            const category = document.getElementById("app-category").value;
            const icon = document.getElementById("app-icon").value.trim() || "🌐";
            if (!title || !url) return;
            try {
              const res = await fetch(labkioskApi("/api/portal-sites"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, url, category, icon })
              });
              const data = await res.json();
              if (data.status === "ok") {
                window.location.search = (window.location.search ? window.location.search + "&" : "?") + "tab=portal";
              } else {
                lkToast(data.error || "Failed to add application", "error");
              }
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        }

        document.querySelectorAll(".btn-delete-app").forEach(btn => {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-id");
            if (!id) return;
            const agreed = await lkConfirm({
              title: "Remove Portal Application?",
              message: "Students will no longer see this application on their learning portal launcher.",
              confirmLabel: "Remove Application",
              tone: "danger"
            });
            if (!agreed) return;
            try {
              const res = await fetch(labkioskApi("/api/portal-sites/" + encodeURIComponent(id)), {
                method: "DELETE"
              });
              const data = await res.json();
              if (data.status === "ok") {
                window.location.search = (window.location.search ? window.location.search + "&" : "?") + "tab=portal";
              } else {
                lkToast(data.error || "Failed to remove application", "error");
              }
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        });

        // -------------------------------------------------------------
        // Whitelist Firewall Management
        // -------------------------------------------------------------
        async function addDomain(rawDomain) {
          let domain = String(rawDomain || "").trim().toLowerCase();
          if (domain.startsWith("http://")) domain = domain.slice(7);
          else if (domain.startsWith("https://")) domain = domain.slice(8);
          const slashIdx = domain.indexOf("/");
          if (slashIdx !== -1) domain = domain.slice(0, slashIdx);
          if (!domain) return;
          try {
            const res = await fetch(labkioskApi("/api/settings/whitelist"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ domain })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.search = (window.location.search ? window.location.search + "&" : "?") + "tab=whitelist";
            } else {
              lkToast(data.error || "Failed to add domain", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        }

        const addDomainForm = document.getElementById("add-domain-form");
        if (addDomainForm) {
          addDomainForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const input = document.getElementById("domain-input");
            addDomain(input.value);
          });
        }

        document.querySelectorAll(".btn-remove-domain").forEach(btn => {
          btn.addEventListener("click", async () => {
            const domain = btn.getAttribute("data-domain");
            if (!domain) return;
            const agreed = await lkConfirm({
              title: "Remove " + domain + " from allowlist?",
              message: "Student thin clients will no longer be permitted to load pages or assets from this domain.",
              confirmLabel: "Remove Domain",
              tone: "danger"
            });
            if (!agreed) return;
            try {
              const res = await fetch(labkioskApi("/api/settings/whitelist/" + encodeURIComponent(domain)), {
                method: "DELETE"
              });
              const data = await res.json();
              if (data.status === "ok") {
                window.location.search = (window.location.search ? window.location.search + "&" : "?") + "tab=whitelist";
              } else {
                lkToast(data.error || "Failed to remove domain", "error");
              }
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        });

        document.querySelectorAll(".btn-pack").forEach(btn => {
          btn.addEventListener("click", async () => {
            const domains = (btn.getAttribute("data-domains") || "").split(",").map(d => d.trim()).filter(Boolean);
            if (!domains.length) return;
            const agreed = await lkConfirm({
              title: "Add preset pack (" + domains.length + " domains)?",
              message: "Permit: " + domains.join(", "),
              confirmLabel: "Add Pack",
              tone: "primary"
            });
            if (!agreed) return;
            try {
              for (const domain of domains) {
                await fetch(labkioskApi("/api/settings/whitelist"), {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ domain })
                });
              }
              window.location.search = (window.location.search ? window.location.search + "&" : "?") + "tab=whitelist";
            } catch (err) {
              lkToast("Network error: " + err.message, "error");
            }
          });
        });

      })();
    </script>
  `;
}
