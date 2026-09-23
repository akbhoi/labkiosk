/**
 * The workstation grid: live telemetry, per-machine remote control, selectable batch
 * commands, and admin-managed collapsible workstation groups.
 *
 * The page markup, its context-panel contents and its client script live
 * together here.
 */

import { LabConfig, Tenant, PortalSite, BroadcastPreset, WorkstationGroup } from "./types";
import { escapeHtml, escapeAttr, escapeJson } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildWorkstationsPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, teachers, groups = [], tenantParam, baseDomain, nonce } = options;
  return {
    title: "Workstation Grid & Control",
    contentHtml: renderWorkstationsPageHtml(tenantParam),
    modalsHtml: renderWorkstationsModalsHtml(tenant, presets, groups),
    scriptsHtml: renderWorkstationsScripts(nonce, tenant, config, presets, sites, groups),
    subPanelTitle: "Workstations",
    subPanelSubtitle: "Telemetry & groups",
    subPanelHtml: `
      <div class="sub-section-title">Grid Density</div>
      <div class="sub-action-list">
        <button type="button" class="sub-action-item" data-density="thumbs">
          <span style="display: flex; align-items: center; gap: 8px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            Screen Thumbnails
          </span>
        </button>
        <button type="button" class="sub-action-item" data-density="compact">
          <span style="display: flex; align-items: center; gap: 8px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            Compact List
          </span>
        </button>
      </div>

      <div class="sub-section-title" style="margin-top: 14px;">Telemetry Filters</div>
      <div class="sub-action-list">
        <button type="button" class="sub-action-item active" data-filter="all">
          <span>All Workstations</span>
          <span class="sub-action-badge" id="sub-filter-all-count">0</span>
        </button>
        <button type="button" class="sub-action-item" data-filter="online">
          <span>Online (Active)</span>
          <span class="sub-action-badge" id="sub-filter-online-count" style="color: #6ee7b7;">0</span>
        </button>
        <button type="button" class="sub-action-item" data-filter="offline">
          <span>Offline / Standby</span>
          <span class="sub-action-badge" id="sub-filter-offline-count">0</span>
        </button>
        <button type="button" class="sub-action-item" data-filter="locked">
          <span>Locked Screens</span>
          <span class="sub-action-badge" id="sub-filter-locked-count" style="color: #fde68a;">0</span>
        </button>
      </div>

      <div class="sub-section-title" style="margin-top: 14px; display: flex; justify-content: space-between; align-items: center;">
        <span>Workstation Groups</span>
        <button type="button" class="btn btn-sm" data-action="new-group" title="Create new group" style="background: transparent; border: none; color: var(--accent); cursor: pointer; padding: 0 4px; font-weight: 700; font-size: 13px;">+ New</button>
      </div>
      <div class="sub-action-list" id="sub-group-list">
        <button type="button" class="sub-action-item" data-filter="group:all">
          <span>All Groups</span>
          <span class="sub-action-badge" id="sub-group-all-count">0</span>
        </button>
        ${groups
          .map(
            (g) => `
        <div class="sub-action-group-row">
          <button type="button" class="sub-action-item" data-filter="group:${escapeAttr(g.name)}" style="flex: 1;">
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(g.name)}</span>
            <span class="sub-action-badge" id="sub-group-${escapeAttr(g.id)}-count">0</span>
          </button>
          <button type="button" class="btn btn-sm" data-action="delete-group" data-id="${escapeAttr(g.id)}" data-name="${escapeAttr(g.name)}" title="Delete group ${escapeAttr(g.name)}" style="padding: 4px 6px; font-size: 11px; background: transparent; border: none; color: var(--text-muted); cursor: pointer;">✕</button>
        </div>`
          )
          .join("")}
        <button type="button" class="sub-action-item" data-filter="group:__ungrouped__">
          <span>Ungrouped</span>
          <span class="sub-action-badge" id="sub-group-ungrouped-count">0</span>
        </button>
      </div>
    `
  };
}

function renderWorkstationsPageHtml(tenantParam: string): string {
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Workstation Grid &amp; Remote Control</h1>
        <p class="page-desc">Real-time classroom telemetry, live screen monitoring, and remote command execution.</p>
      </div>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
        <button type="button" class="btn btn-secondary" id="btn-select-all" title="Select or deselect all visible workstations">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg>
          <span id="btn-select-all-label">Select All</span>
        </button>
        <span id="selection-summary" style="font-size: 12px; color: var(--text-muted); font-weight: 600;">0 selected</span>
        <button type="button" class="btn btn-warning" id="btn-lock-all" title="Locks selected workstations (or all if none selected) with an announcement message">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span id="btn-lock-label">Lock</span>
        </button>
        <button type="button" class="btn btn-secondary" id="btn-unlock-all" title="Unlocks selected workstations (or all if none selected)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
          <span id="btn-unlock-label">Unlock</span>
        </button>
        <button type="button" class="btn btn-primary" id="btn-open-broadcast">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4.93 4.93a10 10 0 0 1 14.14 0"/><path d="M7.76 7.76a6 6 0 0 1 8.48 0"/><circle cx="12" cy="12" r="2"/></svg>
          <span id="btn-broadcast-label">Broadcast URL</span>
        </button>
        <button type="button" class="btn btn-secondary" id="btn-reset-portal">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          Reset to Portal
        </button>
        <button type="button" class="btn btn-warning" id="btn-clear-session-all" title="Sign students out: wipes browser logins, history, cookies and cache on the selected workstations, without a reboot">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          <span id="btn-clear-session-label">Clear Session</span>
        </button>
        <button type="button" class="btn btn-danger" id="btn-reboot-all" title="Reboot the selected workstations">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          <span id="btn-reboot-label">Reboot</span>
        </button>
        <button type="button" class="btn btn-danger" id="btn-shutdown-all" title="Shut down the selected workstations">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          <span id="btn-shutdown-label">Shutdown</span>
        </button>
        <button type="button" class="btn btn-secondary" id="btn-move-group" style="display: none;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          Move to Group...
        </button>
      </div>
    </div>

    <div class="kiosk-grid" id="kiosk-grid">
      <div class="empty-lab-state">
        <p class="empty-lab-title">Connecting to classroom telemetry...</p>
        <p>Workstations will appear here automatically once enrolled.</p>
      </div>
    </div>
  `;
}

/** Remote control, broadcast, lock-screen and group dialogs for the workstation grid. */
function renderWorkstationsModalsHtml(tenant?: Tenant, presets: BroadcastPreset[] = [], groups: WorkstationGroup[] = []): string {
  return `
    <!-- VNC Remote Control Modal -->
    <div class="modal-overlay" id="vnc-modal">
      <div class="modal-box" style="max-width: 1000px; width: 95%; height: 85vh; display: flex; flex-direction: column; padding: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h3 id="vnc-modal-title" style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
            <span class="stat-dot dot-green"></span> Live Remote Control
          </h3>
          <button type="button" class="modal-close" id="btn-close-vnc" aria-label="Close dialog">✕</button>
        </div>
        <div id="vnc-notice" style="display: none; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #93c5fd; margin-bottom: 10px;"></div>
        <iframe id="vnc-frame" src="about:blank" style="flex: 1; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: #000;" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      </div>
    </div>

    <!-- Broadcast URL Modal -->
    <div class="modal-overlay" id="url-modal">
      <div class="modal-box" style="max-width: 540px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 id="url-modal-title" style="font-size: 16px; font-weight: 700;">Broadcast URL to Workstations</h3>
          <button type="button" class="modal-close" id="btn-cancel-broadcast" aria-label="Close dialog">✕</button>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;" id="url-modal-desc">
          Enter an educational website URL to immediately navigate student workstations.
        </p>
        <div style="margin-bottom: 14px;">
          <input type="url" id="target-url-input" class="form-input" placeholder="https://..." value="${escapeHtml(tenant?.default_url || "")}" style="width: 100%; font-family: 'JetBrains Mono', monospace; font-size: 13px;">
        </div>
        <div id="broadcast-error" style="color: var(--danger); font-size: 12px; margin-bottom: 10px; min-height: 16px;"></div>
        <div style="margin-bottom: 16px;">
          <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px;">Quick Shortcuts</div>
          <div id="broadcast-quick-links" style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px;">
            <button type="button" class="btn btn-sm btn-secondary" data-url="https://scratch.mit.edu">Scratch</button>
            <button type="button" class="btn btn-sm btn-secondary" data-url="https://phet.colorado.edu">PhET Sims</button>
            <button type="button" class="btn btn-sm btn-secondary" data-url="https://www.khanacademy.org">Khan Academy</button>
            <button type="button" class="btn btn-sm btn-secondary" data-url="https://en.wikipedia.org">Wikipedia</button>
          </div>
          <div id="broadcast-custom-shortcuts" style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${presets.map((p) => `<button type="button" class="btn btn-sm btn-secondary" data-url="${escapeAttr(p.url)}">${escapeHtml(p.title)}</button>`).join("")}
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" id="btn-reset-broadcast">Reset to Portal</button>
          <button type="button" class="btn btn-primary" id="btn-send-broadcast">Broadcast Now</button>
        </div>
      </div>
    </div>

    <!-- Lock Screen Modal -->
    <div class="modal-overlay" id="lock-modal">
      <div class="modal-box" style="max-width: 500px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 id="lock-modal-title" style="font-size: 16px; font-weight: 700;">Lock Workstations</h3>
          <button type="button" class="modal-close" id="btn-cancel-lock" aria-label="Close dialog">✕</button>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;" id="lock-modal-desc">
          Freeze student screens with an announcement message. Keystrokes and shortcuts are locked.
        </p>
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Announcement Message</label>
          <input type="text" id="lock-msg-input" class="form-input" value="${escapeHtml(tenant?.default_lock_message || "Screens locked by the instructor. Please look to the front.")}" maxlength="280" style="width: 100%;">
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" id="btn-cancel-lock-action">Cancel</button>
          <button type="button" class="btn btn-warning" id="btn-send-lock">Lock Workstations</button>
        </div>
      </div>
    </div>

    <!-- New Group Modal -->
    <div class="modal-overlay" id="new-group-modal">
      <div class="modal-box" style="max-width: 440px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 style="font-size: 16px; font-weight: 700;">Create Workstation Group</h3>
          <button type="button" class="modal-close" id="btn-cancel-new-group" aria-label="Close dialog">✕</button>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Organize client PCs into groups (e.g. &quot;Row 1&quot;, &quot;Lab A&quot;, &quot;Team Blue&quot;) to quickly filter and run commands.
        </p>
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Group Name</label>
          <input type="text" id="new-group-name-input" class="form-input" placeholder="e.g. Row 1" maxlength="50" style="width: 100%;">
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" id="btn-cancel-new-group-action">Cancel</button>
          <button type="button" class="btn btn-primary" id="btn-submit-new-group">Create Group</button>
        </div>
      </div>
    </div>

    <!-- Move to Group Modal -->
    <div class="modal-overlay" id="move-group-modal">
      <div class="modal-box" style="max-width: 440px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 id="move-group-modal-title" style="font-size: 16px; font-weight: 700;">Assign Workstations to Group</h3>
          <button type="button" class="modal-close" id="btn-cancel-move-group" aria-label="Close dialog">✕</button>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;" id="move-group-modal-desc">
          Choose a group for the selected workstations.
        </p>
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Select Group</label>
          <select id="move-group-select" class="form-input" style="width: 100%;">
            <option value="">-- Remove from Group (Ungrouped) --</option>
            ${groups.map((g) => `<option value="${escapeAttr(g.name)}">${escapeHtml(g.name)}</option>`).join("")}
          </select>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" id="btn-cancel-move-group-action">Cancel</button>
          <button type="button" class="btn btn-primary" id="btn-submit-move-group">Apply</button>
        </div>
      </div>
    </div>
  `;
}

function renderWorkstationsScripts(
  nonce: string,
  tenant?: Tenant,
  config?: LabConfig,
  presets: BroadcastPreset[] = [],
  sites: PortalSite[] = [],
  initialGroups: WorkstationGroup[] = []
): string {
  const tunnelDomain = tenant?.tunnel_domain || config?.tunnelDomain || "demo.labkiosk.akbhoi.com";
  const isDemo = tenant?.subdomain === "demo";

  return `
    <script nonce="${escapeAttr(nonce)}">
      const TUNNEL_DOMAIN = ${escapeJson(tunnelDomain)};
      const IS_DEMO = ${isDemo ? "true" : "false"};
      let clientsData = {};
      let groupsList = ${escapeJson(initialGroups.map((g) => ({ id: g.id, name: g.name })))};
      let selectedClientIds = new Set();
      let activeFilter = "all";
      let activeLockTargets = null;

      function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
      }

      // --------------------------------------------------------- grid density
      var DENSITY_KEY = "labkiosk_grid_density";
      var density = "thumbs";
      try {
        if (localStorage.getItem(DENSITY_KEY) === "compact") density = "compact";
      } catch (err) {}

      var VIEWPORT_MARGIN = 250;

      function isNearViewport(card) {
        var box = card.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return false;
        var limit = window.innerHeight || document.documentElement.clientHeight;
        return box.bottom >= -VIEWPORT_MARGIN && box.top <= limit + VIEWPORT_MARGIN;
      }

      function wantsThumbnail(card) {
        if (density === "compact") return false;
        return isNearViewport(card);
      }

      var refreshQueued = false;
      function refreshVisibleCards() {
        if (refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(function () {
          refreshQueued = false;
          if (density === "compact") return;
          for (var id in clientsData) {
            var card = document.getElementById("card-" + id);
            if (!card) continue;
            var thumb = card.querySelector('[data-role="thumb"]');
            var hasFrame = !!(thumb && thumb.getAttribute("src"));
            if (hasFrame !== wantsThumbnail(card)) updateCard(card, id, clientsData[id]);
          }
        });
      }
      window.addEventListener("scroll", refreshVisibleCards, { passive: true });
      window.addEventListener("resize", refreshVisibleCards, { passive: true });

      function applyDensity(next) {
        density = next === "compact" ? "compact" : "thumbs";
        var grid = document.getElementById("kiosk-grid");
        if (grid) grid.classList.toggle("compact", density === "compact");
        try {
          localStorage.setItem(DENSITY_KEY, density);
        } catch (err) {}
        for (var id in clientsData) {
          var card = document.getElementById("card-" + id);
          if (card) updateCard(card, id, clientsData[id]);
        }
      }
      window.labkioskApplyDensity = applyDensity;
      window.labkioskGridDensity = function () { return density; };

      // --------------------------------------------------------- selection state
      function getVisibleClientIds() {
        const grid = document.getElementById("kiosk-grid");
        if (!grid) return [];
        const visible = [];
        const cards = grid.querySelectorAll(".kiosk-card");
        for (let i = 0; i < cards.length; i++) {
          if (cards[i].style.display !== "none") {
            visible.push(cards[i].id.replace("card-", ""));
          }
        }
        return visible;
      }

      function updateCardSelection(id) {
        const card = document.getElementById("card-" + id);
        if (!card) return;
        const isSelected = selectedClientIds.has(id);
        card.classList.toggle("selected", isSelected);
        const cb = card.querySelector(".kc-select-checkbox");
        if (cb) cb.checked = isSelected;
      }

      function updateSelectionToolbar() {
        const visibleIds = getVisibleClientIds();
        const selCount = selectedClientIds.size;

        const summary = document.getElementById("selection-summary");
        if (summary) summary.textContent = selCount + " selected";

        const selectAllLabel = document.getElementById("btn-select-all-label");
        if (selectAllLabel) {
          const allVisSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedClientIds.has(id));
          selectAllLabel.textContent = allVisSelected ? "Deselect All" : "Select All";
        }

        const lockLabel = document.getElementById("btn-lock-label");
        if (lockLabel) lockLabel.textContent = selCount ? "Lock (" + selCount + ")" : "Lock";

        const unlockLabel = document.getElementById("btn-unlock-label");
        if (unlockLabel) unlockLabel.textContent = selCount ? "Unlock (" + selCount + ")" : "Unlock";

        const clearLabel = document.getElementById("btn-clear-session-label");
        if (clearLabel) clearLabel.textContent = selCount ? "Clear Session (" + selCount + ")" : "Clear Session";

        const rebootLabel = document.getElementById("btn-reboot-label");
        if (rebootLabel) rebootLabel.textContent = selCount ? "Reboot (" + selCount + ")" : "Reboot";

        const shutdownLabel = document.getElementById("btn-shutdown-label");
        if (shutdownLabel) shutdownLabel.textContent = selCount ? "Shutdown (" + selCount + ")" : "Shutdown";

        const moveBtn = document.getElementById("btn-move-group");
        if (moveBtn) moveBtn.style.display = selCount > 0 ? "inline-flex" : "none";

        // Update group-level checkboxes
        for (const sec of document.querySelectorAll(".group-section")) {
          const gBox = sec.querySelector(".group-select-checkbox");
          if (!gBox) continue;
          const gCards = sec.querySelectorAll(".kiosk-card");
          let gVis = 0, gSel = 0;
          for (let i = 0; i < gCards.length; i++) {
            if (gCards[i].style.display !== "none") {
              gVis++;
              const cid = gCards[i].id.replace("card-", "");
              if (selectedClientIds.has(cid)) gSel++;
            }
          }
          gBox.checked = gVis > 0 && gSel === gVis;
          gBox.indeterminate = gSel > 0 && gSel < gVis;
        }
      }

      // --------------------------------------------------------- card element
      function createCardElement(id) {
        const card = el("div", "card kiosk-card");
        card.id = "card-" + id;

        const head = el("div", "kc-head");
        const idWrap = el("div", "kc-id");

        const selectCb = document.createElement("input");
        selectCb.type = "checkbox";
        selectCb.className = "kc-select-checkbox";
        selectCb.dataset.clientId = id;
        selectCb.checked = selectedClientIds.has(id);
        selectCb.title = "Select " + id;
        selectCb.addEventListener("click", (e) => e.stopPropagation());
        selectCb.addEventListener("change", () => {
          if (selectCb.checked) selectedClientIds.add(id);
          else selectedClientIds.delete(id);
          updateCardSelection(id);
          updateSelectionToolbar();
        });

        const dot = el("span", "stat-dot dot-red");
        dot.dataset.role = "dot";
        idWrap.append(selectCb, dot, el("span", null, id));

        const badges = el("div", "kc-badges");
        const lockBadge = el("span", "badge badge-yellow", "LOCKED");
        lockBadge.dataset.role = "lock-badge";
        lockBadge.style.display = "none";
        const removeBtn = el("button", "btn btn-sm btn-secondary", "✕");
        removeBtn.title = "Remove " + id;
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          removeClient(id);
        });
        badges.append(lockBadge, removeBtn);
        head.append(idWrap, badges);

        const thumbBox = el("div", "kc-thumb-box");
        const thumb = document.createElement("img");
        thumb.dataset.role = "thumb";
        thumb.className = "kc-thumb";
        thumb.alt = "Screen preview for " + id;
        thumb.loading = "lazy";
        thumb.decoding = "async";
        const placeholder = el("div", "kc-placeholder", "Standby / Offline");
        placeholder.dataset.role = "placeholder";
        thumbBox.append(thumb, placeholder);

        const actions = el("div", "kc-actions");
        const vncBtn = el("button", "btn btn-sm btn-primary", "Remote Control");
        vncBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openVncSession(id);
        });
        const lockBtn = el("button", "btn btn-sm btn-secondary", "Lock");
        lockBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          sendCommand([id], "lock");
        });
        const unlockBtn = el("button", "btn btn-sm btn-secondary", "Unlock");
        unlockBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          sendCommand([id], "unlock");
        });
        const reloadBtn = el("button", "btn btn-sm btn-secondary", "Reload");
        reloadBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          sendCommand([id], "reload");
        });
        actions.append(vncBtn, lockBtn, unlockBtn, reloadBtn);

        const footer = el("div", "kc-footer");
        const urlSpan = el("span", "kc-url", "Ready");
        urlSpan.dataset.role = "url";
        const ipSpan = el("span", "kc-ip", "--");
        ipSpan.dataset.role = "ip";
        footer.append(urlSpan, ipSpan);

        card.append(head, thumbBox, actions, footer);
        if (selectedClientIds.has(id)) card.classList.add("selected");
        return card;
      }

      function updateCard(card, id, client) {
        const dot = card.querySelector('[data-role="dot"]');
        const thumb = card.querySelector('[data-role="thumb"]');
        const placeholder = card.querySelector('[data-role="placeholder"]');
        const lockBadge = card.querySelector('[data-role="lock-badge"]');
        const urlSpan = card.querySelector('[data-role="url"]');
        const ipSpan = card.querySelector('[data-role="ip"]');
        const cb = card.querySelector(".kc-select-checkbox");
        if (cb) cb.checked = selectedClientIds.has(id);
        card.classList.toggle("selected", selectedClientIds.has(id));

        if (client && client.online) {
          dot.className = "stat-dot dot-green";
          if (client.thumbnail && client.thumbnail.startsWith("data:image/") && wantsThumbnail(card)) {
            thumb.src = client.thumbnail;
            thumb.classList.add("live");
            placeholder.style.display = "none";
          } else {
            thumb.removeAttribute("src");
            thumb.classList.remove("live");
            placeholder.style.display = "block";
            placeholder.textContent = "Live (No Frame)";
          }
          lockBadge.style.display = client.isLocked ? "inline-flex" : "none";
          try {
            urlSpan.textContent = new URL(client.activeUrl).hostname;
          } catch {
            urlSpan.textContent = client.activeUrl || "Ready";
          }
        } else {
          dot.className = "stat-dot dot-red";
          thumb.removeAttribute("src");
          thumb.classList.remove("live");
          placeholder.style.display = "block";
          placeholder.textContent = "Standby / Offline";
          lockBadge.style.display = "none";
          urlSpan.textContent = "Offline";
        }
        ipSpan.textContent = (client && client.ip) || "--";
      }

      // --------------------------------------------------------- group section manager
      function getOrCreateGroupSection(groupName, displayName) {
        const grid = document.getElementById("kiosk-grid");
        let sec = grid.querySelector('.group-section[data-group-name="' + CSS.escape(groupName) + '"]');
        if (!sec) {
          sec = document.createElement("div");
          sec.className = "group-section";
          sec.dataset.groupName = groupName;
          try {
            if (localStorage.getItem("labkiosk_group_collapsed_" + groupName) === "true") {
              sec.classList.add("collapsed");
            }
          } catch (_) {}

          const header = document.createElement("div");
          header.className = "group-section-header";

          const toggleBtn = document.createElement("button");
          toggleBtn.type = "button";
          toggleBtn.className = "group-collapse-btn";
          toggleBtn.innerHTML = '<svg class="group-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>';

          const groupCb = document.createElement("input");
          groupCb.type = "checkbox";
          groupCb.className = "group-select-checkbox";
          groupCb.title = "Select all in " + displayName;
          groupCb.addEventListener("click", (e) => {
            e.stopPropagation();
            const cards = sec.querySelectorAll(".kiosk-card");
            for (let i = 0; i < cards.length; i++) {
              if (cards[i].style.display !== "none") {
                const cid = cards[i].id.replace("card-", "");
                if (groupCb.checked) selectedClientIds.add(cid);
                else selectedClientIds.delete(cid);
                updateCardSelection(cid);
              }
            }
            updateSelectionToolbar();
          });

          const title = document.createElement("span");
          title.className = "group-title";
          title.textContent = displayName;

          const badge = document.createElement("span");
          badge.className = "group-count-badge";
          badge.dataset.role = "group-badge";
          badge.textContent = "0 PCs";

          header.append(toggleBtn, groupCb, title, badge);
          header.addEventListener("click", (e) => {
            if (e.target === groupCb) return;
            sec.classList.toggle("collapsed");
            try {
              localStorage.setItem("labkiosk_group_collapsed_" + groupName, sec.classList.contains("collapsed"));
            } catch (_) {}
          });

          const cardsGrid = document.createElement("div");
          cardsGrid.className = "group-cards-grid";

          sec.append(header, cardsGrid);
          grid.appendChild(sec);
        }
        return sec;
      }

      // --------------------------------------------------------- poll telemetry
      async function pollClients() {
        try {
          const res = await fetch(labkioskApi("/api/clients"));
          if (!res.ok) return;
          const data = await res.json();
          clientsData = data.clients || {};

          const grid = document.getElementById("kiosk-grid");
          const ids = Object.keys(clientsData).sort();

          if (!ids.length) {
            grid.innerHTML = '<div class="empty-lab-state"><p class="empty-lab-title">No Thin Clients Connected</p><p>Workstations appear here once enrolled with the school key.</p></div>';
            document.getElementById("stat-online-count").textContent = "0";
            document.getElementById("stat-total-count").textContent = "0";
            document.getElementById("stat-locked-count").textContent = "0";
            setPanelCounts(0, 0, 0, 0);
            updateSelectionToolbar();
            return;
          }

          const empty = grid.querySelector(".empty-lab-state");
          if (empty) empty.remove();

          // Remove deleted cards
          for (const card of Array.from(grid.querySelectorAll(".kiosk-card"))) {
            const cid = card.id.replace("card-", "");
            if (!clientsData[cid]) {
              card.remove();
              selectedClientIds.delete(cid);
            }
          }

          let online = 0, locked = 0;
          const groupCounts = { "__ungrouped__": { total: 0, online: 0 } };
          for (const g of groupsList) groupCounts[g.name] = { total: 0, online: 0 };

          for (const id of ids) {
            const c = clientsData[id];
            if (c && c.online) online++;
            if (c && c.online && c.isLocked) locked++;

            const gName = (c && c.groupName) ? c.groupName : "__ungrouped__";
            const gDisplay = (c && c.groupName) ? c.groupName : "Ungrouped Workstations";

            if (!groupCounts[gName]) groupCounts[gName] = { total: 0, online: 0 };
            groupCounts[gName].total++;
            if (c && c.online) groupCounts[gName].online++;

            const sec = getOrCreateGroupSection(gName, gDisplay);
            const cardsGrid = sec.querySelector(".group-cards-grid");

            let card = document.getElementById("card-" + id);
            if (!card) {
              card = createCardElement(id);
              cardsGrid.appendChild(card);
            } else if (card.parentElement !== cardsGrid) {
              cardsGrid.appendChild(card);
            }
            updateCard(card, id, c);
          }

          // Update group section badges & prune empty dynamic groups
          for (const sec of Array.from(grid.querySelectorAll(".group-section"))) {
            const gName = sec.dataset.groupName;
            const stats = groupCounts[gName];
            if (!stats || stats.total === 0) {
              sec.remove();
            } else {
              const b = sec.querySelector('[data-role="group-badge"]');
              if (b) b.textContent = stats.total + " PCs (" + stats.online + " Online)";
            }
          }

          // Update sidebar group counts
          const allGrpBadge = document.getElementById("sub-group-all-count");
          if (allGrpBadge) allGrpBadge.textContent = String(ids.length);
          const unGrpBadge = document.getElementById("sub-group-ungrouped-count");
          if (unGrpBadge) unGrpBadge.textContent = String((groupCounts["__ungrouped__"] && groupCounts["__ungrouped__"].total) || 0);

          for (const g of groupsList) {
            const b = document.getElementById("sub-group-" + g.id + "-count");
            if (b) b.textContent = String((groupCounts[g.name] && groupCounts[g.name].total) || 0);
          }

          document.getElementById("stat-online-count").textContent = String(online);
          document.getElementById("stat-total-count").textContent = String(ids.length);
          document.getElementById("stat-locked-count").textContent = String(locked);
          setPanelCounts(ids.length, online, ids.length - online, locked);

          applyFilter(activeFilter);
          updateSelectionToolbar();
        } catch (err) {
          console.warn("Telemetry poll:", err);
        }
      }

      function openVncSession(id) {
        document.getElementById("vnc-modal-title").textContent = "Live Remote Control: " + id;
        const client = clientsData[id] || {};
        const host = window.location.hostname;
        let base = "";

        if (client.remoteHost) {
          base = "https://" + client.remoteHost;
        } else if (host === "localhost" || host === "127.0.0.1" || host.includes("docker")) {
          base = "http://" + host + ":6080";
        } else if (IS_DEMO) {
          base = "https://" + encodeURIComponent(id.toLowerCase()) + "." + TUNNEL_DOMAIN;
        } else if (TUNNEL_DOMAIN && TUNNEL_DOMAIN !== "lab.myschool.edu") {
          base = "https://" + encodeURIComponent(id.toLowerCase()) + "." + TUNNEL_DOMAIN;
        } else {
          base = "http://localhost:6080";
          const notice = document.getElementById("vnc-notice");
          notice.textContent = "Notice: Cloudflare Tunnel domain is not configured for this school. Remote control is accessible via local simulator (port 6080) or after configuring a tunnel in Lab Settings.";
          notice.style.display = "block";
        }

        const params = new URLSearchParams({ autoconnect: "true", resize: "scale" });
        if (client.vncPassword) params.set("password", client.vncPassword);
        document.getElementById("vnc-frame").src = base + "/vnc.html?" + params.toString();
        document.getElementById("vnc-modal").classList.add("active");
      }

      document.getElementById("btn-close-vnc").addEventListener("click", () => {
        document.getElementById("vnc-modal").classList.remove("active");
        document.getElementById("vnc-frame").src = "about:blank";
        document.getElementById("vnc-notice").style.display = "none";
      });

      // --------------------------------------------------------- command execution
      async function sendCommand(targets, action, extra = {}) {
        try {
          const payload = Array.isArray(targets) ? { targets, action, ...extra } : { target: targets, action, ...extra };
          const res = await fetch(labkioskApi("/api/command"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (data.status === "ok") {
            lkToast("Command dispatched to " + (Array.isArray(targets) ? targets.length + " workstation(s)" : targets), "success");
            pollClients();
          } else {
            lkToast(data.error || "Command failed", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      }

      async function removeClient(clientId) {
        var agreed = await lkConfirm({
          title: "Decommission " + clientId + "?",
          message: "Its device token is revoked immediately. The workstation has to be re-enrolled with the school key before it can reconnect.",
          confirmLabel: "Decommission",
          tone: "danger"
        });
        if (!agreed) return;
        try {
          const res = await fetch(labkioskApi("/api/clients/remove"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId })
          });
          const data = await res.json();
          if (data.status === "ok") {
            const card = document.getElementById("card-" + clientId);
            if (card) card.remove();
            selectedClientIds.delete(clientId);
            delete clientsData[clientId];
            pollClients();
          } else {
            lkToast(data.error || "Failed to remove workstation", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      }

      function getSelectedOrAll(promptIfAll = false) {
        if (selectedClientIds.size > 0) {
          return Array.from(selectedClientIds);
        }
        const visible = getVisibleClientIds();
        if (visible.length === 0) {
          lkToast("No workstations available.", "warning");
          return null;
        }
        if (promptIfAll) {
          return visible;
        }
        lkToast("Select one or more workstations first, or click Select All.", "info");
        return null;
      }

      // Toolbar button listeners
      document.getElementById("btn-select-all").addEventListener("click", () => {
        const visible = getVisibleClientIds();
        if (!visible.length) return;
        const allSelected = visible.every((id) => selectedClientIds.has(id));
        if (allSelected) {
          for (const id of visible) selectedClientIds.delete(id);
        } else {
          for (const id of visible) selectedClientIds.add(id);
        }
        for (const id of visible) updateCardSelection(id);
        updateSelectionToolbar();
      });

      document.getElementById("btn-lock-all").addEventListener("click", () => {
        activeLockTargets = getSelectedOrAll(true);
        if (!activeLockTargets) return;
        const title = document.getElementById("lock-modal-title");
        if (title) title.textContent = "Lock Workstations (" + activeLockTargets.length + ")";
        const btn = document.getElementById("btn-send-lock");
        if (btn) btn.textContent = "Lock " + activeLockTargets.length + " Screen(s)";
        openModal("lock-modal");
      });

      document.getElementById("btn-unlock-all").addEventListener("click", () => {
        const targets = getSelectedOrAll(true);
        if (targets) sendCommand(targets, "unlock");
      });

      document.getElementById("btn-reset-portal").addEventListener("click", () => {
        const targets = getSelectedOrAll(true);
        if (targets) sendCommand(targets, "navigate", { resetPortal: true });
      });

      document.getElementById("btn-reboot-all").addEventListener("click", async () => {
        const targets = getSelectedOrAll(false);
        if (!targets) return;
        const agreed = await lkConfirm({
          title: "Reboot " + targets.length + " workstation(s)?",
          message: "Selected student machines restart now. Anything on screen is lost, and each one returns to the portal after reboot.",
          confirmLabel: "Reboot",
          tone: "danger"
        });
        if (agreed) sendCommand(targets, "reboot");
      });

      document.getElementById("btn-shutdown-all").addEventListener("click", async () => {
        const targets = getSelectedOrAll(false);
        if (!targets) return;
        const agreed = await lkConfirm({
          title: "Shutdown " + targets.length + " workstation(s)?",
          message: "Selected student machines will power off completely. All transient data in the RAM overlay will reset, and machines must be powered back on physically.",
          confirmLabel: "Shutdown",
          tone: "danger"
        });
        if (agreed) sendCommand(targets, "shutdown");
      });

      // End of a class period: sign everyone out without restarting the machine.
      document.getElementById("btn-clear-session-all").addEventListener("click", async () => {
        const targets = getSelectedOrAll(false);
        if (!targets) return;
        const agreed = await lkConfirm({
          title: "Clear the session on " + targets.length + " workstation(s)?",
          message: "The browser restarts in a few seconds with nothing left behind: every website sign-in, cookie, history entry, cache and unsaved form is removed. Anything a student has not saved elsewhere is lost. The machines stay on and reopen their assigned page.",
          confirmLabel: "Clear Session",
          tone: "danger"
        });
        if (agreed) sendCommand(targets, "clear-session");
      });

      document.getElementById("btn-open-broadcast").addEventListener("click", () => {
        const targets = getSelectedOrAll(true);
        if (!targets) return;
        const desc = document.getElementById("url-modal-desc");
        if (desc) desc.textContent = "Navigating " + targets.length + " workstation(s) to the specified website.";
        openModal("url-modal");
      });

      // --------------------------------------------------------- group management
      async function fetchGroups() {
        try {
          const res = await fetch(labkioskApi("/api/groups"));
          if (!res.ok) return;
          const data = await res.json();
          groupsList = data.groups || [];
          renderSidebarGroupList();
          updateMoveGroupSelect();
        } catch (err) {
          console.warn("fetchGroups:", err);
        }
      }

      function renderSidebarGroupList() {
        const list = document.getElementById("sub-group-list");
        if (!list) return;

        // Group names are typed by staff: built as nodes with textContent and
        // dataset, never concatenated into markup (Rule 4).
        function filterButton(filter, label, badgeId, count) {
          const btn = el("button", "sub-action-item" + (activeFilter === filter ? " active" : ""));
          btn.type = "button";
          btn.dataset.filter = filter;
          const name = el("span", null, label);
          const badge = el("span", "sub-action-badge", count);
          badge.id = badgeId;
          btn.append(name, badge);
          return btn;
        }

        const nodes = [filterButton("group:all", "All Groups", "sub-group-all-count", Object.keys(clientsData).length)];
        for (const g of groupsList) {
          const row = el("div", "sub-action-group-row");
          const btn = filterButton("group:" + g.name, g.name, "sub-group-" + g.id + "-count", 0);
          btn.style.flex = "1";
          btn.firstChild.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
          const del = el("button", "btn btn-sm", "✕");
          del.type = "button";
          del.dataset.action = "delete-group";
          del.dataset.id = g.id;
          del.dataset.name = g.name;
          del.title = "Delete group " + g.name;
          del.style.cssText = "padding: 4px 6px; font-size: 11px; background: transparent; border: none; color: var(--text-muted); cursor: pointer;";
          row.append(btn, del);
          nodes.push(row);
        }
        nodes.push(filterButton("group:__ungrouped__", "Ungrouped", "sub-group-ungrouped-count", 0));
        list.replaceChildren(...nodes);
      }

      function updateMoveGroupSelect() {
        const sel = document.getElementById("move-group-select");
        if (!sel) return;
        const options = [new Option("-- Remove from Group (Ungrouped) --", "")];
        for (const g of groupsList) options.push(new Option(g.name, g.name));
        sel.replaceChildren(...options);
      }

      window.labkioskOpenNewGroupDialog = function () {
        const inp = document.getElementById("new-group-name-input");
        if (inp) inp.value = "";
        openModal("new-group-modal");
        if (inp) inp.focus();
      };

      window.labkioskDeleteGroup = async function (groupId, groupName) {
        const agreed = await lkConfirm({
          title: "Delete group \\"" + groupName + "\\"? ",
          message: "Workstations in this group will become ungrouped. No client computers will be disconnected.",
          confirmLabel: "Delete Group",
          tone: "danger"
        });
        if (!agreed) return;

        try {
          const res = await fetch(labkioskApi("/api/groups/" + encodeURIComponent(groupId)), {
            method: "DELETE"
          });
          const data = await res.json();
          if (data.status === "ok") {
            lkToast("Group deleted", "success");
            if (activeFilter === "group:" + groupName) activeFilter = "all";
            await fetchGroups();
            await pollClients();
          } else {
            lkToast(data.error || "Failed to delete group", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      };

      document.getElementById("btn-cancel-new-group").addEventListener("click", () => closeModal("new-group-modal"));
      document.getElementById("btn-cancel-new-group-action").addEventListener("click", () => closeModal("new-group-modal"));
      document.getElementById("btn-submit-new-group").addEventListener("click", async () => {
        const inp = document.getElementById("new-group-name-input");
        const name = (inp ? inp.value : "").trim();
        if (!name) return lkToast("Please enter a group name", "warning");

        try {
          const res = await fetch(labkioskApi("/api/groups"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name })
          });
          const data = await res.json();
          if (data.status === "ok") {
            closeModal("new-group-modal");
            lkToast("Group \\"" + name + "\\" created", "success");
            await fetchGroups();

            if (selectedClientIds.size > 0) {
              const moveAgreed = await lkConfirm({
                title: "Move Selected to New Group?",
                message: "Assign the " + selectedClientIds.size + " selected workstation(s) to " + name + "?",
                confirmLabel: "Assign to " + name
              });
              if (moveAgreed) {
                await assignSelectedToGroup(name);
              }
            }
          } else {
            lkToast(data.error || "Failed to create group", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      // Move group modal
      document.getElementById("btn-move-group").addEventListener("click", () => {
        if (!selectedClientIds.size) return;
        updateMoveGroupSelect();
        const desc = document.getElementById("move-group-modal-desc");
        if (desc) desc.textContent = "Assign " + selectedClientIds.size + " selected workstation(s) to:";
        openModal("move-group-modal");
      });

      document.getElementById("btn-cancel-move-group").addEventListener("click", () => closeModal("move-group-modal"));
      document.getElementById("btn-cancel-move-group-action").addEventListener("click", () => closeModal("move-group-modal"));
      document.getElementById("btn-submit-move-group").addEventListener("click", async () => {
        const sel = document.getElementById("move-group-select");
        const groupName = sel ? sel.value : null;
        closeModal("move-group-modal");
        await assignSelectedToGroup(groupName || null);
      });

      async function assignSelectedToGroup(groupName) {
        const clientIds = Array.from(selectedClientIds);
        if (!clientIds.length) return;

        try {
          const res = await fetch(labkioskApi("/api/clients/group"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientIds, groupName })
          });
          const data = await res.json();
          if (data.status === "ok") {
            lkToast("Moved " + clientIds.length + " workstation(s) to " + (groupName || "Ungrouped"), "success");
            await pollClients();
          } else {
            lkToast(data.error || "Failed to assign group", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      }

      // --------------------------------------------------------- context panel hooks
      function setPanelCounts(total, online, offline, locked) {
        var counts = {
          "sub-filter-all-count": total,
          "sub-filter-online-count": online,
          "sub-filter-offline-count": offline,
          "sub-filter-locked-count": locked
        };
        for (var id in counts) {
          var node = document.getElementById(id);
          if (node) node.textContent = String(counts[id]);
        }
      }

      function matchesFilter(client) {
        if (!client) return false;
        if (activeFilter.startsWith("group:")) {
          const targetGroup = activeFilter.slice("group:".length);
          if (targetGroup === "all") return true;
          if (targetGroup === "__ungrouped__") return !client.groupName;
          return client.groupName === targetGroup;
        }
        var online = !!client.online;
        if (activeFilter === "online") return online;
        if (activeFilter === "offline") return !online;
        if (activeFilter === "locked") return online && !!client.isLocked;
        return true;
      }

      function applyFilter(name) {
        activeFilter = name || "all";
        var grid = document.getElementById("kiosk-grid");
        if (!grid) return;
        var shown = 0;
        var cards = grid.querySelectorAll(".kiosk-card");
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];
          var keep = matchesFilter(clientsData[card.id.replace("card-", "")]);
          card.style.display = keep ? "" : "none";
          if (keep) shown++;
        }

        // Hide group sections that have 0 visible cards
        for (const sec of grid.querySelectorAll(".group-section")) {
          let hasVisible = false;
          for (const c of sec.querySelectorAll(".kiosk-card")) {
            if (c.style.display !== "none") {
              hasVisible = true;
              break;
            }
          }
          sec.style.display = hasVisible ? "" : "none";
        }

        var note = document.getElementById("filter-empty-note");
        if (cards.length && !shown) {
          if (!note) {
            note = document.createElement("div");
            note.id = "filter-empty-note";
            note.className = "empty-lab-state";
            grid.appendChild(note);
          }
          note.textContent = "No workstations match this filter.";
        } else if (note) {
          note.remove();
        }
        updateSelectionToolbar();
      }
      window.labkioskApplyFilter = applyFilter;

      window.labkioskOpenLockDialog = function () {
        activeLockTargets = getSelectedOrAll(true);
        if (!activeLockTargets) return;
        const title = document.getElementById("lock-modal-title");
        if (title) title.textContent = "Lock Workstations (" + activeLockTargets.length + ")";
        const btn = document.getElementById("btn-send-lock");
        if (btn) btn.textContent = "Lock " + activeLockTargets.length + " Screen(s)";
        openModal("lock-modal");
      };

      function openModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.add("active");
      }
      function closeModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.remove("active");
      }

      // Modals event listeners
      document.getElementById("btn-cancel-broadcast").addEventListener("click", () => closeModal("url-modal"));
      document.getElementById("btn-send-broadcast").addEventListener("click", () => {
        const input = document.getElementById("target-url-input");
        const url = input ? input.value.trim() : "";
        if (url) {
          const targets = getSelectedOrAll(true);
          if (targets) {
            sendCommand(targets, "navigate", { url });
            closeModal("url-modal");
          }
        }
      });
      document.getElementById("btn-reset-broadcast").addEventListener("click", () => {
        const targets = getSelectedOrAll(true);
        if (targets) {
          sendCommand(targets, "navigate", { resetPortal: true });
          closeModal("url-modal");
        }
      });

      const urlModal = document.getElementById("url-modal");
      if (urlModal) {
        urlModal.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-url]");
          if (btn && btn.dataset.url) {
            const input = document.getElementById("target-url-input");
            if (input) input.value = btn.dataset.url;
          }
        });
      }

      document.getElementById("btn-cancel-lock").addEventListener("click", () => closeModal("lock-modal"));
      document.getElementById("btn-cancel-lock-action").addEventListener("click", () => closeModal("lock-modal"));
      document.getElementById("btn-send-lock").addEventListener("click", () => {
        const msgInput = document.getElementById("lock-msg-input");
        const message = msgInput ? msgInput.value.trim() : "";
        const targets = activeLockTargets || getSelectedOrAll(true);
        if (targets) {
          sendCommand(targets, "lock", { message });
          closeModal("lock-modal");
        }
      });

      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        for (const overlay of document.querySelectorAll(".modal-overlay.active")) {
          if (overlay.id === "vnc-modal") {
            overlay.classList.remove("active");
            document.getElementById("vnc-frame").src = "about:blank";
            document.getElementById("vnc-notice").style.display = "none";
          } else {
            overlay.classList.remove("active");
          }
        }
      });
      for (const overlay of document.querySelectorAll(".modal-overlay")) {
        overlay.addEventListener("click", (e) => {
          if (e.target !== overlay) return;
          if (overlay.id === "vnc-modal") {
            overlay.classList.remove("active");
            document.getElementById("vnc-frame").src = "about:blank";
            document.getElementById("vnc-notice").style.display = "none";
          } else {
            overlay.classList.remove("active");
          }
        });
      }

      applyDensity(density);
      pollClients();
      setInterval(pollClients, 3000);
    </script>
  `;
}
