/**
 * The workstation grid: live telemetry, per-machine remote control, batch
 * commands, and the dialogs they open.
 *
 * The page markup, its context-panel contents and its client script live
 * together here. They used to sit hundreds of lines apart inside one
 * 2,450-line module, which is how a panel full of controls that nothing
 * handled went unnoticed for so long.
 */

import { LabConfig, Tenant, PortalSite, BroadcastPreset } from "./types";
import { escapeHtml, escapeAttr, escapeJson } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildWorkstationsPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, teachers, tenantParam, baseDomain, nonce } = options;
  return {
    title: "Workstation Grid & Control",
    contentHtml: renderWorkstationsPageHtml(tenantParam),
    modalsHtml: renderWorkstationsModalsHtml(tenant, presets),
    scriptsHtml: renderWorkstationsScripts(nonce, tenant, config, presets, sites),
        subPanelTitle: "Workstations",
        subPanelSubtitle: "Telemetry & batch commands",
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

          <div class="sub-section-title" style="margin-top: 14px;">Classroom Commands</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-action="open-broadcast">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.93 4.93a10 10 0 0 1 14.14 0"/><path d="M7.76 7.76a6 6 0 0 1 8.48 0"/><circle cx="12" cy="12" r="2"/></svg>
                Broadcast URL
              </span>
            </button>
            <button type="button" class="sub-action-item" data-action="open-lock-all">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Lock All Screens
              </span>
            </button>
            <button type="button" class="sub-action-item" data-action="open-unlock-all">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                Unlock All
              </span>
            </button>
            <button type="button" class="sub-action-item" data-action="reset-portal">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Reset to Portal
              </span>
            </button>
            <button type="button" class="sub-action-item" data-action="open-reboot-all" style="color: #fca5a5;">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                Reboot All PCs
              </span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Quick Navigation</div>
          <div class="sub-action-list">
            <a href="/admin/broadcast${tenantParam}" class="sub-action-item">
              <span>Lesson Broadcast</span>
              <span style="color: var(--text-muted);">→</span>
            </a>
            <a href="/admin/portal${tenantParam}" class="sub-action-item">
              <span>Portal Apps (${sites.length})</span>
              <span style="color: var(--text-muted);">→</span>
            </a>
            <a href="/admin/whitelist${tenantParam}" class="sub-action-item">
              <span>Allowed Domains (${config?.whitelist?.length || 0})</span>
              <span style="color: var(--text-muted);">→</span>
            </a>
            <a href="/admin/settings${tenantParam}" class="sub-action-item">
              <span>Lab Settings</span>
              <span style="color: var(--text-muted);">→</span>
            </a>
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
      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
        <button type="button" class="btn btn-warning" id="btn-lock-all">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Lock All Screens
        </button>
        <button type="button" class="btn btn-secondary" id="btn-unlock-all">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
          Unlock All
        </button>
        <button type="button" class="btn btn-primary" id="btn-open-broadcast">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4.93 4.93a10 10 0 0 1 14.14 0"/><path d="M7.76 7.76a6 6 0 0 1 8.48 0"/><circle cx="12" cy="12" r="2"/></svg>
          Broadcast URL
        </button>
        <a class="btn btn-secondary" href="/admin/whitelist${tenantParam}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Allowed Domains
        </a>
        <a class="btn btn-secondary" href="/admin/portal${tenantParam}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          Portal Apps
        </a>
        <a class="btn btn-secondary" href="/admin/settings${tenantParam}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Settings
        </a>
        <button type="button" class="btn btn-primary" id="btn-reset-portal">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          Reset to Portal
        </button>
        <button type="button" class="btn btn-danger" id="btn-reboot-all">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          Reboot All
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

/** Remote control, broadcast and lock-screen dialogs for the workstation grid. */
function renderWorkstationsModalsHtml(tenant?: Tenant, presets: BroadcastPreset[] = []): string {
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
          <h3 id="url-modal-title" style="font-size: 16px; font-weight: 700;">Broadcast URL to All Workstations</h3>
          <button type="button" class="modal-close" id="btn-cancel-broadcast" aria-label="Close dialog">✕</button>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Enter an educational website URL to immediately navigate all student workstations.
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
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Freeze all student screens with an announcement message. Keystrokes and shortcuts are locked.
        </p>
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Announcement Message</label>
          <input type="text" id="lock-msg-input" class="form-input" value="${escapeHtml(tenant?.default_lock_message || "Screens locked by the instructor. Please look to the front.")}" maxlength="280" style="width: 100%;">
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" id="btn-cancel-lock-action">Cancel</button>
          <button type="button" class="btn btn-warning" id="btn-send-lock">Lock All Workstations</button>
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
  sites: PortalSite[] = []
): string {
  const tunnelDomain = tenant?.tunnel_domain || config?.tunnelDomain || "demo.labkiosk.akbhoi.com";
  const isDemo = tenant?.subdomain === "demo";

  return `
    <script nonce="${escapeAttr(nonce)}">
      const TUNNEL_DOMAIN = ${escapeJson(tunnelDomain)};
      const IS_DEMO = ${isDemo ? "true" : "false"};
      let clientsData = {};

      function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
      }

      // --------------------------------------------------------- grid density
      // A 40-machine lab decodes 40 base64 JPEGs every three seconds and runs to
      // four rows of scrolling. Two things cut that: a compact mode with no
      // thumbnails at all, and never assigning a frame to a card nobody can see.

      var DENSITY_KEY = "labkiosk_grid_density";
      var density = "thumbs";
      try {
        if (localStorage.getItem(DENSITY_KEY) === "compact") density = "compact";
      } catch (err) {
        // Storage denied. The default is the right one to fall back to.
      }

      // Visibility is measured, not remembered. An IntersectionObserver was the
      // obvious choice and went stale here: cards are observed before they are
      // appended, so the first batch kept the flag from its initial callback and
      // scrolling never corrected it. A rect read cannot disagree with the
      // layout, and 30-odd of them every three seconds is nothing next to the
      // JPEG decodes this exists to avoid.
      var VIEWPORT_MARGIN = 250;

      /** Is this card on screen, or about to be? */
      function isNearViewport(card) {
        var box = card.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return false;
        var limit = window.innerHeight || document.documentElement.clientHeight;
        return box.bottom >= -VIEWPORT_MARGIN && box.top <= limit + VIEWPORT_MARGIN;
      }

      /** Is this card worth decoding a frame for right now? */
      function wantsThumbnail(card) {
        if (density === "compact") return false;
        return isNearViewport(card);
      }

      /**
       * Repaint whatever scrolling has just brought into view, rather than
       * waiting up to three seconds for the next telemetry poll.
       */
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
            // Only touch the cards whose answer has actually changed.
            if (hasFrame !== wantsThumbnail(card)) updateCard(card, id, clientsData[id]);
          }
        });
      }
      window.addEventListener("scroll", refreshVisibleCards, { passive: true });
      window.addEventListener("resize", refreshVisibleCards, { passive: true });

      /** Switch between the thumbnail grid and the one-line-per-machine list. */
      function applyDensity(next) {
        density = next === "compact" ? "compact" : "thumbs";
        var grid = document.getElementById("kiosk-grid");
        if (grid) grid.classList.toggle("compact", density === "compact");
        try {
          localStorage.setItem(DENSITY_KEY, density);
        } catch (err) {
          // A preference that cannot be remembered still applies to this session.
        }
        for (var id in clientsData) {
          var card = document.getElementById("card-" + id);
          if (card) updateCard(card, id, clientsData[id]);
        }
      }
      window.labkioskApplyDensity = applyDensity;
      window.labkioskGridDensity = function () { return density; };

      function createCardElement(id) {
        const card = el("div", "card kiosk-card");
        card.id = "card-" + id;

        const head = el("div", "kc-head");
        const idWrap = el("div", "kc-id");
        const dot = el("span", "stat-dot dot-red");
        dot.dataset.role = "dot";
        idWrap.append(dot, el("span", null, id));

        const badges = el("div", "kc-badges");
        const lockBadge = el("span", "badge badge-yellow", "LOCKED");
        lockBadge.dataset.role = "lock-badge";
        lockBadge.style.display = "none";
        const removeBtn = el("button", "btn btn-sm btn-secondary", "✕");
        removeBtn.title = "Remove " + id;
        removeBtn.addEventListener("click", () => removeClient(id));
        badges.append(lockBadge, removeBtn);
        head.append(idWrap, badges);

        const thumbBox = el("div", "kc-thumb-box");
        const thumb = document.createElement("img");
        thumb.dataset.role = "thumb";
        thumb.className = "kc-thumb";
        thumb.alt = "Screen preview for " + id;
        // The browser still decodes a frame it is told to paint off-screen.
        thumb.loading = "lazy";
        thumb.decoding = "async";
        const placeholder = el("div", "kc-placeholder", "Standby / Offline");
        placeholder.dataset.role = "placeholder";
        thumbBox.append(thumb, placeholder);

        const actions = el("div", "kc-actions");
        const vncBtn = el("button", "btn btn-sm btn-primary", "Remote Control");
        vncBtn.addEventListener("click", () => openVncSession(id));
        const lockBtn = el("button", "btn btn-sm btn-secondary", "Lock");
        lockBtn.addEventListener("click", () => sendCommand(id, "lock"));
        const unlockBtn = el("button", "btn btn-sm btn-secondary", "Unlock");
        unlockBtn.addEventListener("click", () => sendCommand(id, "unlock"));
        const reloadBtn = el("button", "btn btn-sm btn-secondary", "Reload");
        reloadBtn.addEventListener("click", () => sendCommand(id, "reload"));
        actions.append(vncBtn, lockBtn, unlockBtn, reloadBtn);

        const footer = el("div", "kc-footer");
        const urlSpan = el("span", "kc-url", "Ready");
        urlSpan.dataset.role = "url";
        const ipSpan = el("span", "kc-ip", "--");
        ipSpan.dataset.role = "ip";
        footer.append(urlSpan, ipSpan);

        card.append(head, thumbBox, actions, footer);
        return card;
      }

      function updateCard(card, id, client) {
        const dot = card.querySelector('[data-role="dot"]');
        const thumb = card.querySelector('[data-role="thumb"]');
        const placeholder = card.querySelector('[data-role="placeholder"]');
        const lockBadge = card.querySelector('[data-role="lock-badge"]');
        const urlSpan = card.querySelector('[data-role="url"]');
        const ipSpan = card.querySelector('[data-role="ip"]');

        if (client && client.online) {
          dot.className = "stat-dot dot-green";
          if (client.thumbnail && client.thumbnail.startsWith("data:image/") && wantsThumbnail(card)) {
            thumb.src = client.thumbnail;
            thumb.classList.add("live");
            placeholder.style.display = "none";
          } else {
            // Drop the data URL as well as hiding the element: an <img> keeps a
            // decoded bitmap alive for as long as it has a src.
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
            return;
          }

          const empty = grid.querySelector(".empty-lab-state");
          if (empty) empty.remove();

          for (const card of Array.from(grid.querySelectorAll(".kiosk-card"))) {
            if (!clientsData[card.id.replace("card-", "")]) card.remove();
          }

          let online = 0, locked = 0;
          for (const id of ids) {
            let card = document.getElementById("card-" + id);
            if (!card) {
              card = createCardElement(id);
              grid.appendChild(card);
            }
            const c = clientsData[id];
            if (c && c.online) online++;
            if (c && c.online && c.isLocked) locked++;
            updateCard(card, id, c);
          }

          document.getElementById("stat-online-count").textContent = String(online);
          document.getElementById("stat-total-count").textContent = String(ids.length);
          document.getElementById("stat-locked-count").textContent = String(locked);
          setPanelCounts(ids.length, online, ids.length - online, locked);
          applyFilter(activeFilter);
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

      async function sendCommand(target, action, extra = {}) {
        try {
          const res = await fetch(labkioskApi("/api/command"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target, action, ...extra })
          });
          const data = await res.json();
          if (data.status === "ok") {
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
            delete clientsData[clientId];
            pollClients();
          } else {
            lkToast(data.error || "Failed to remove workstation", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      }

      document.getElementById("btn-lock-all").addEventListener("click", () => sendCommand("all", "lock"));
      document.getElementById("btn-unlock-all").addEventListener("click", () => sendCommand("all", "unlock"));
      document.getElementById("btn-reset-portal").addEventListener("click", () => sendCommand("all", "navigate", { resetPortal: true }));
      document.getElementById("btn-reboot-all").addEventListener("click", async () => {
        const agreed = await lkConfirm({
          title: "Reboot every workstation?",
          message: "All student machines restart now. Anything on screen is lost, and each one comes back to the portal after about a minute.",
          confirmLabel: "Reboot all",
          tone: "danger"
        });
        if (agreed) sendCommand("all", "reboot");
      });

      // ------------------------------------------------ context panel hooks
      // The Level 2 panel is rendered by the shell and has no access to this
      // closure, so the two things it needs are published on window.

      var activeFilter = "all";

      /**
       * The four tallies beside the panel filters. They were server-rendered
       * as zero and then never touched, so the panel always claimed an empty
       * lab however many workstations were reporting.
       */
      function setPanelCounts(total, online, offline, locked) {
        var counts = {
          "sub-filter-all-count": total,
          "sub-filter-online-count": online,
          "sub-filter-offline-count": offline,
          "sub-filter-locked-count": locked
        };
        for (var id in counts) {
          var el = document.getElementById(id);
          if (el) el.textContent = String(counts[id]);
        }
      }

      /** Does this workstation belong in the current filter? */
      function matchesFilter(client) {
        var online = !!(client && client.online);
        if (activeFilter === "online") return online;
        if (activeFilter === "offline") return !online;
        if (activeFilter === "locked") return online && !!client.isLocked;
        return true;
      }

      /** Show only the cards the filter keeps, and say so when none remain. */
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
      }
      window.labkioskApplyFilter = applyFilter;

      /** Open the lock dialog so a teacher can set the announcement text. */
      window.labkioskOpenLockDialog = function () {
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

      const btnOpenBroadcast = document.getElementById("btn-open-broadcast");
      if (btnOpenBroadcast) btnOpenBroadcast.addEventListener("click", () => openModal("url-modal"));
      const btnCancelBroadcast = document.getElementById("btn-cancel-broadcast");
      if (btnCancelBroadcast) btnCancelBroadcast.addEventListener("click", () => closeModal("url-modal"));

      const btnSendBroadcast = document.getElementById("btn-send-broadcast");
      if (btnSendBroadcast) {
        btnSendBroadcast.addEventListener("click", () => {
          const input = document.getElementById("target-url-input");
          const url = input ? input.value.trim() : "";
          if (url) {
            sendCommand("all", "navigate", { url });
            closeModal("url-modal");
          }
        });
      }
      const btnResetBroadcast = document.getElementById("btn-reset-broadcast");
      if (btnResetBroadcast) {
        btnResetBroadcast.addEventListener("click", () => {
          sendCommand("all", "navigate", { resetPortal: true });
          closeModal("url-modal");
        });
      }

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

      const btnCancelLock = document.getElementById("btn-cancel-lock");
      if (btnCancelLock) btnCancelLock.addEventListener("click", () => closeModal("lock-modal"));
      const btnCancelLockAction = document.getElementById("btn-cancel-lock-action");
      if (btnCancelLockAction) btnCancelLockAction.addEventListener("click", () => closeModal("lock-modal"));
      const btnSendLock = document.getElementById("btn-send-lock");
      if (btnSendLock) {
        btnSendLock.addEventListener("click", () => {
          const msgInput = document.getElementById("lock-msg-input");
          const message = msgInput ? msgInput.value.trim() : "";
          sendCommand("all", "lock", { message });
          closeModal("lock-modal");
        });
      }

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
