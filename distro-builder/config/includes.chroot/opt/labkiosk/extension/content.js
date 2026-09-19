/**
 * Lab Kiosk Navigation Bar & Lockdown Content Script
 * Injected into top-level pages to provide locked navigation controls,
 * real-time telemetry indicators, and fullscreen lock curtain.
 */

/**
 * The last layer of the keyboard and mouse lockdown.
 *
 * Openbox binds nothing and the X keymap has had the F keys, the Super keys,
 * the menu key and the XF86 block removed (labkiosk-lock-keys), so most of what
 * follows should never arrive. This catches what does: a page's own shortcuts,
 * Chromium accelerators that are still reachable with Control or Alt, and the
 * context menu.
 *
 * Deliberately permissive about one thing: typing. Letters, digits,
 * punctuation, Backspace, Delete, Enter, Shift, Caps Lock, Tab, Escape and the
 * cursor keys all pass through, because a workstation that cannot fill in a
 * form is not locked down, it is broken.
 *
 * And deliberately permissive about one more: the clipboard, *only* on the
 * setup wizard. The enrolment key is a 20-character string an administrator
 * pastes from the dashboard, and taking Ctrl+V away there would make the one
 * screen that needs it unusable. Students never see that origin.
 */
(function lockInput() {
  const AGENT_ORIGIN = "http://127.0.0.1:8888";
  const CLIPBOARD_KEYS = new Set(["a", "c", "v", "x", "z", "y"]);

  // Keys that pass on their own, with no modifier.
  const ALLOWED_KEYS = new Set([
    "Backspace", "Delete", "Enter", "NumpadEnter", "Shift", "CapsLock", "Tab", "Escape",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
    "Control", "Alt", "AltGraph", "NumLock", "Dead", "Process"
  ]);

  const isSetupPage = window.location.origin === AGENT_ORIGIN;

  function isTypedCharacter(event) {
    // A single printable character: "a", "7", "@". Dead keys and IME give
    // longer names, which fall through to the rules below.
    return event.key.length === 1;
  }

  function permitted(event) {
    if (typeof event.getModifierState === "function" && event.getModifierState("AltGraph")) {
      if (isTypedCharacter(event) || event.key === "Dead" || ALLOWED_KEYS.has(event.key)) {
        return true;
      }
    }
    const combination = event.ctrlKey || event.altKey || event.metaKey;
    if (combination) {
      // Shift is not a combination -- it is how capitals are typed.
      if (isSetupPage && event.ctrlKey && !event.altKey && !event.metaKey &&
          CLIPBOARD_KEYS.has(event.key.toLowerCase())) {
        return true;
      }
      return false;
    }
    if (ALLOWED_KEYS.has(event.key)) return true;
    if (isTypedCharacter(event)) return true;
    // Everything else: F keys, Meta, ContextMenu, PrintScreen, Insert, Pause,
    // and anything a keyboard invents that this list has never heard of.
    return false;
  }

  function guard(event) {
    if (permitted(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // Capture phase, so a page's own handler never runs either.
  for (const type of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(type, guard, true);
  }

  // Right click, and the menu key that does the same thing.
  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();

(function () {
  // Only inject in top window (never in sub-iframes)
  if (window.self !== window.top) return;

  /**
   * Agent state is read through the extension's service worker, not fetched
   * directly. A content script runs in the page's origin, so a direct fetch to
   * the agent would be cross-origin and would require the agent to answer every
   * site with `Access-Control-Allow-Origin: *`.
   */
  function askAgent(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (settled) return;
          settled = true;
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!reply || !reply.ok) {
            reject(new Error((reply && reply.error) || "Agent unavailable"));
          } else {
            resolve(reply);
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }
  let lastTargetUrl = null;
  let isLocked = false;
  let lastReloadEpoch = null;
  try {
    const saved = sessionStorage.getItem("labkiosk_reload_epoch");
    if (saved) lastReloadEpoch = Number(saved);
  } catch {}
  // When the agent first reported the workstation offline; null while online.
  let offlineSince = null;
  const OFFLINE_REDIRECT_MS = 6000;
  // Long enough to notice the bar and read the workstation name, short enough
  // that it is out of the way before anyone starts a lesson.
  let barCatalog = {};

  /**
   * The bar's own strings, in whatever language the wizard chose.
   *
   * At this scope on purpose: the nav-button titles and the network tooltip are
   * set from functions that sit beside the one that builds the bar, not inside
   * it, so a t() declared in there would not exist by the time they run.
   */
  function t(key, fallback) {
    const value = barCatalog[key];
    return typeof value === "string" && value ? value : fallback;
  }
const BAR_INTRO_MS = 2500;
  const AGENT_SETUP_URL = "http://127.0.0.1:8888/setup";

  function isAgentPage(href) {
    try {
      const url = new URL(href);
      return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "8888";
    } catch {
      return false;
    }
  }

  /**
   * Mirror of the active broadcast marker owned by the service worker.
   *
   * This lives in the isolated world, so page script cannot reach it, and it is
   * read synchronously by isAtBroadcastRoot() from a keydown handler where an
   * await is not an option. The authoritative copy is in chrome.storage.session
   * via background.js, which is what survives navigation between pages.
   */
  let broadcastState = { epoch: "0", url: "" };

  function applyBroadcastState(next) {
    if (next && typeof next.epoch === "string") {
      broadcastState = { epoch: next.epoch, url: typeof next.url === "string" ? next.url : "" };
    }
    return broadcastState;
  }

  async function loadBroadcastState() {
    try {
      const reply = await askAgent({ type: "labkiosk:broadcast-get" });
      applyBroadcastState(reply.broadcast);
    } catch {
      // Keep the default; the next sync tick retries.
    }
  }

  async function storeBroadcastState(epoch, url) {
    applyBroadcastState({ epoch: String(epoch), url: url || "" });
    try {
      const reply = await askAgent({ type: "labkiosk:broadcast-set", epoch: String(epoch), url });
      applyBroadcastState(reply.broadcast);
    } catch {
      // The mirror is already updated; persistence retries on the next change.
    }
  }

  async function clearBroadcastState() {
    applyBroadcastState({ epoch: "0", url: "" });
    try {
      await askAgent({ type: "labkiosk:broadcast-clear" });
    } catch {
      // As above.
    }
  }

  // While the teacher's curtain is up, stop the page underneath from seeing any
  // input. This is a DOM-level block, not an X11 input grab: it prevents the
  // student interacting with the page, while Chromium's kiosk switches and the
  // stripped Openbox keybindings cover browser- and window-level shortcuts.
  const SWALLOWED_WHILE_LOCKED = [
    "click", "dblclick", "mousedown", "mouseup", "wheel",
    "keydown", "keypress", "keyup", "touchstart", "touchmove", "touchend"
  ];
  for (const type of SWALLOWED_WHILE_LOCKED) {
    window.addEventListener(
      type,
      (e) => {
        if (!isLocked) return;
        // Let the curtain itself keep working; everything else is discarded.
        if (e.composedPath && e.composedPath().some((n) => n && n.id === "labkiosk-root")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true
    );
  }

  // A closed shadow root is not reachable from the host element, so the only
  // handles to the kiosk UI are these two.
  let uiHost = null;
  let uiShadow = null;

  /** An http(s) URL safe to navigate to, or null. */
  function httpUrlOrNull(raw) {
    if (!raw) return null;
    try {
      const parsed = new URL(raw, window.location.href);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function normalizeUrl(raw) {
    if (!raw) return "";
    try {
      const u = new URL(raw, window.location.href);
      const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
      return (u.origin + path).toLowerCase() + u.search;
    } catch {
      return "";
    }
  }

  function isAtBroadcastRoot() {
    const broadcastUrl = broadcastState.url;
    if (!broadcastUrl) return false;
    const cur = normalizeUrl(window.location.href);
    const root = normalizeUrl(broadcastUrl);
    return Boolean(cur && root && cur === root);
  }

  // 1. Block right click and inspection shortcuts + back navigation at broadcast root
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);
  window.addEventListener(
    "keydown",
    (e) => {
      if (
        e.key === "F12" ||
        (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key.toUpperCase())) ||
        (e.ctrlKey && ["u", "U"].includes(e.key)) ||
        e.key === "F11"
      ) {
        e.preventDefault();
        e.stopPropagation();
      } else if (
        (e.altKey && e.key === "ArrowLeft") ||
        (e.key === "Backspace" && !["INPUT", "TEXTAREA"].includes((document.activeElement && document.activeElement.tagName) || ""))
      ) {
        if (isAtBroadcastRoot()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    true
  );

  // 2. Create Isolated Shadow DOM Container for Top Bar & Curtain
  function initKioskUi() {
    // Always return a usable shadow root. Returning undefined when the UI already
    // exists let a second call (DOMContentLoaded firing after the first sync tick
    // had already built it) overwrite `shadowRoot` with undefined, after which the
    // status loop skipped its whole update block: the bar still rendered and its
    // dot kept its default green, but the lock curtain never appeared again.
    const existing = document.getElementById("labkiosk-root");
    if (existing && existing === uiHost && uiShadow) return uiShadow;
    if (existing) {
      existing.remove();
    }

    const host = document.createElement("div");
    host.id = "labkiosk-root";
    host.style.cssText = "all: initial; position: absolute; z-index: 2147483647;";

    // "closed" so the host page cannot reach this subtree through
    // document.getElementById("labkiosk-root").shadowRoot and delete the lock
    // curtain out from under the teacher. The content script keeps its own
    // reference below, which is unaffected.
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        
        #kiosk-sensor {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 10px;
          background: transparent;
          z-index: 2147483646;
          pointer-events: none;
        }

        #kiosk-bar {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 44px;
          background: rgba(15, 23, 42, 0.96);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-bottom: 1px solid #334155;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          color: #f8fafc;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          user-select: none;
          z-index: 2147483647;
          transform: translateY(-100%);
          opacity: 0;
          pointer-events: none;
          transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
        }

        #kiosk-bar.visible {
          transform: translateY(0);
          opacity: 1;
          pointer-events: auto;
        }

        .nav-cluster {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .kiosk-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #1e293b;
          border: 1px solid #334155;
          color: #f8fafc;
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .kiosk-btn:hover {
          background: #3b82f6;
          border-color: #3b82f6;
          color: #ffffff;
        }

        .kiosk-btn:active {
          transform: scale(0.96);
        }

        .domain-pill {
          display: flex;
          align-items: center;
          gap: 8px;
          background: #1e293b;
          padding: 5px 14px;
          border-radius: 20px;
          border: 1px solid #334155;
          font-family: monospace;
          font-size: 13px;
          color: #93c5fd;
          max-width: 35vw;
          min-width: 0;
          overflow: hidden;
        }

        #kiosk-domain {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .client-meta {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          font-weight: 600;
        }

        .kiosk-icon-btn {
          background: transparent;
          border: none;
          color: #94a3b8;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 4px;
          border-radius: 6px;
          transition: all 0.15s ease;
        }

        .kiosk-icon-btn:hover {
          color: #38bdf8;
          background: #1e293b;
        }

        .kiosk-icon-btn:active {
          transform: scale(0.95);
        }

        .status-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 8px #10b981;
        }
        .status-dot.offline {
          background: #ef4444;
          box-shadow: 0 0 8px #ef4444;
        }

        .kiosk-clock {
          display: flex; align-items: center; gap: 6px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #e2e8f0; border-radius: 8px;
          padding: 5px 10px; font-size: 12px; font-weight: 700;
          font-variant-numeric: tabular-nums; cursor: pointer;
          white-space: nowrap;
        }
        .kiosk-clock:hover { background: rgba(255, 255, 255, 0.12); }

        /* Administrator Verification Modal */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: rgba(0, 0, 0, 0.75);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          z-index: 2147483647;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .modal-overlay.hidden {
          display: none;
        }

        .modal-card {
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 12px;
          padding: 24px;
          width: 380px;
          max-width: 90vw;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.7);
          color: #f8fafc;
        }

        .modal-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }

        .modal-title {
          font-size: 16px;
          font-weight: 700;
          color: #f8fafc;
        }

        .modal-desc {
          font-size: 13px;
          color: #94a3b8;
          margin-bottom: 16px;
          line-height: 1.4;
        }

        .modal-input {
          width: 100%;
          background: #1e293b;
          border: 1px solid #475569;
          border-radius: 6px;
          padding: 9px 12px;
          color: #f8fafc;
          font-size: 14px;
          outline: none;
          transition: border-color 0.15s;
        }

        .modal-input:focus {
          border-color: #38bdf8;
        }

        .modal-err {
          color: #f87171;
          font-size: 12px;
          margin-top: 6px;
          font-weight: 500;
        }

        .modal-err.hidden {
          display: none;
        }

        .modal-actions {
          display: flex;
          gap: 10px;
          margin-top: 20px;
          justify-content: flex-end;
        }

        .modal-btn {
          border: none;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .modal-btn-cancel {
          background: #334155;
          color: #cbd5e1;
        }

        .modal-btn-cancel:hover {
          background: #475569;
          color: #ffffff;
        }

        .modal-btn-confirm {
          background: #2563eb;
          color: #ffffff;
        }

        .modal-btn-confirm:hover {
          background: #1d4ed8;
        }

        .modal-btn-confirm:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* Fullscreen Lockdown Curtain */
        #lock-curtain {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: #090d16;
          z-index: 2147483647;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 24px;
          color: #ffffff;
        }

        #lock-curtain.hidden {
          display: none;
        }

        .curtain-card {
          background: #111827;
          border: 1px solid #374151;
          border-radius: 16px;
          padding: 48px;
          max-width: 620px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.9);
        }

        .lock-icon {
          width: 64px;
          height: 64px;
          margin: 0 auto 20px;
          color: #f87171;
        }

        .lock-title {
          font-size: 32px;
          font-weight: 800;
          margin-bottom: 16px;
          letter-spacing: -0.5px;
        }

        .lock-msg {
          font-size: 18px;
          color: #9ca3af;
          line-height: 1.6;
        }
      </style>

      <div id="kiosk-sensor"></div>

      <div id="kiosk-bar">
        <div class="nav-cluster">
          <button class="kiosk-btn" id="btn-home" title="Lesson Home" data-i18n-title="bar.homeTitle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
            <span data-i18n="bar.home">Home</span>
          </button>
          <button class="kiosk-btn" id="btn-back" title="Go Back" data-i18n-title="bar.backTitle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
            <span data-i18n="bar.back">Back</span>
          </button>
          <button class="kiosk-btn" id="btn-forward" title="Go Forward" data-i18n-title="bar.forwardTitle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
            <span data-i18n="bar.forward">Forward</span>
          </button>
          <button class="kiosk-btn" id="btn-reload" title="Reload Page" data-i18n-title="bar.reloadTitle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <span data-i18n="bar.reload">Reload</span>
          </button>
        </div>

        <div class="domain-pill">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
          <span id="kiosk-domain"></span>
        </div>

        <div class="client-meta">
          <button class="kiosk-icon-btn" id="btn-network" title="Network Configuration" data-i18n-title="bar.networkTitle">
            <svg id="kiosk-net-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
              <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
              <line x1="12" y1="20" x2="12.01" y2="20"></line>
            </svg>
          </button>
          <!--
            The clock sits right after the network icon and opens the same wizard
            page the network icon does, on its Language & Region step: it is the
            one place a teacher can see the time is wrong, so it is also where
            they should be able to put it right. Behind the same password.
          -->
          <button class="kiosk-clock" id="btn-clock" title="Date, time and language"
                  data-i18n-title="bar.clockTitle">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>
            </svg>
            <span id="kiosk-clock-text"></span>
          </button>
          <div class="status-dot" id="kiosk-dot"></div>
          <span id="kiosk-client-id">PC-01</span>
        </div>
      </div>

      <div id="lock-curtain" class="hidden">
        <div class="curtain-card">
          <svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <h1 class="lock-title">Attention Please</h1>
          <p class="lock-msg" id="lock-text">Screens locked by the instructor. Please look to the front.</p>
        </div>
      </div>

      <div id="admin-modal" class="modal-overlay hidden">
        <div class="modal-card">
          <div class="modal-header">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <h3 class="modal-title" data-i18n="admin.title">Administrator Verification</h3>
          </div>
          <p class="modal-desc" id="admin-modal-desc" data-i18n="admin.prompt">Enter the administrator or boot password to configure network settings.</p>
          <input type="password" id="admin-modal-input" class="modal-input" placeholder="Enter password" autocomplete="off" />
          <div id="admin-modal-err" class="modal-err hidden" data-i18n="admin.invalid">Invalid administrator password.</div>
          <div class="modal-actions">
            <button type="button" class="modal-btn modal-btn-cancel" id="btn-admin-modal-cancel" data-i18n="admin.cancel">Cancel</button>
            <button type="button" class="modal-btn modal-btn-confirm" id="btn-admin-modal-submit" data-i18n="admin.unlock">Unlock</button>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);
    uiHost = host;
    uiShadow = shadow;

    const domainLabel = shadow.getElementById("kiosk-domain");
    if (domainLabel) {
      domainLabel.textContent = window.location.hostname || "Educational Resource";
    }

    // Ensure zero body margin so the page gets 100% full viewport height without overflow
    if (document.body && document.body.style.marginTop) {
      document.body.style.marginTop = "";
    }

    const bar = shadow.getElementById("kiosk-bar");
    const sensor = shadow.getElementById("kiosk-sensor");
    let hideTimer = null;

    function showBar() {
      if (isLocked) return;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (bar) bar.classList.add("visible");
    }

    function hideBar(delay = 400) {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (bar && !bar.matches(":hover")) {
          bar.classList.remove("visible");
        }
      }, delay);
    }

    // Top sensor and bar hover listeners
    sensor.addEventListener("mouseenter", showBar);
    bar.addEventListener("mouseenter", () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    });
    bar.addEventListener("mouseleave", () => hideBar(300));

    // Global window mousemove detector
    window.addEventListener(
      "mousemove",
      (e) => {
        if (e.clientY <= 12) {
          showBar();
        } else if (e.clientY > 55) {
          if (bar && bar.classList.contains("visible") && !bar.matches(":hover")) {
            hideBar(300);
          }
        }
      },
      { passive: true }
    );

    window.addEventListener("mouseleave", () => hideBar(200));

    // Show the bar once at the start of each session, then let it hide itself.
    // It is invisible until the pointer reaches the top edge, which nobody
    // discovers by accident; this is how a student learns it is there at all.
    // The service worker hands out the "first page of this session" flag, so
    // this happens once per boot rather than on every navigation.
    askAgent({ type: "labkiosk:intro-peek" })
      .then((reply) => {
        if (!reply || !reply.first) return;
        showBar();
        hideBar(BAR_INTRO_MS);
      })
      .catch(() => {
        // The service worker may still be starting; the bar simply stays hidden.
      });

    // Touch support for touchscreens
    window.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches && e.touches[0] && e.touches[0].clientY <= 25) {
          showBar();
        } else if (e.touches && e.touches[0] && e.touches[0].clientY > 60) {
          hideBar(200);
        }
      },
      { passive: true }
    );

    // Button event listeners
    // Strings the bar sets from script rather than from its own markup: the
    // English is the argument, so a catalog only ever overrides it.
    const adminDesc = shadow.getElementById("admin-modal-desc");
    // Interface language. The bar is built in English and then translated in
    // place, so a missing, partial or broken catalog leaves it readable.
    askAgent({ type: "labkiosk:i18n" }).then((reply) => {
      const catalog = (reply && reply.catalog) || {};
      barCatalog = catalog;
      shadow.querySelectorAll("[data-i18n]").forEach((el) => {
        const value = catalog[el.dataset.i18n];
        if (typeof value === "string" && value) el.textContent = value;
      });
      shadow.querySelectorAll("[data-i18n-title]").forEach((el) => {
        const value = catalog[el.dataset.i18nTitle];
        if (typeof value === "string" && value) el.title = value;
      });
      const dir = (catalog._meta || {}).direction === "rtl" ? "rtl" : "ltr";
      host.setAttribute("dir", dir);
      if (bar) bar.setAttribute("dir", dir);
      const curtain = shadow.getElementById("lock-curtain");
      if (curtain) curtain.setAttribute("dir", dir);
      const adminModal = shadow.getElementById("admin-modal");
      if (adminModal) adminModal.setAttribute("dir", dir);
    }).catch(() => { /* English stands */ });

    shadow.getElementById("btn-home").onclick = async () => {
      try {
        const { status } = await askAgent({ type: "labkiosk:status" });
        const target = status.targetUrl || broadcastState.url;
        const safeTarget = httpUrlOrNull(target);
        if (safeTarget) {
          window.location.href = safeTarget;
        }
      } catch (e) {
        console.warn("[LabKiosk] Home target unavailable:", e);
      }
    };
    shadow.getElementById("btn-back").onclick = () => {
      if (isAtBroadcastRoot()) {
        console.log("[LabKiosk] Back navigation blocked at broadcast root");
        return;
      }
      window.history.back();
    };
    shadow.getElementById("btn-forward").onclick = () => window.history.forward();
    shadow.getElementById("btn-reload").onclick = () => window.location.reload();

    const adminModal = shadow.getElementById("admin-modal");
    const adminInput = shadow.getElementById("admin-modal-input");
    const adminErr = shadow.getElementById("admin-modal-err");
    const btnAdminSubmit = shadow.getElementById("btn-admin-modal-submit");
    const btnAdminCancel = shadow.getElementById("btn-admin-modal-cancel");
    const btnNetwork = shadow.getElementById("btn-network");

    // Which page the password is being asked for. The modal is shared, so the
    // destination has to travel with it rather than be assumed.
    let adminModalTarget = "network";

    function openAdminModal(target) {
      adminModalTarget = target === "locale" ? "locale" : "network";
      if (adminDesc) {
        adminDesc.textContent = adminModalTarget === "locale"
          ? t("admin.promptLocale", "Enter the administrator or boot password to change the date, time and language.")
          : t("admin.prompt", "Enter the administrator or boot password to configure network settings.");
      }
      if (!adminModal) return;
      if (adminErr) adminErr.classList.add("hidden");
      if (adminInput) {
        adminInput.value = "";
        setTimeout(() => adminInput.focus(), 60);
      }
      adminModal.classList.remove("hidden");
    }

    function closeAdminModal() {
      if (!adminModal) return;
      adminModal.classList.add("hidden");
      if (adminInput) adminInput.value = "";
      if (adminErr) adminErr.classList.add("hidden");
    }

    async function submitAdminPassword() {
      if (!adminInput || !btnAdminSubmit) return;
      const val = adminInput.value;
      btnAdminSubmit.disabled = true;
      if (adminErr) adminErr.classList.add("hidden");

      try {
        const reply = await askAgent({ type: "labkiosk:verify-admin", password: val });
        if (reply && reply.verified && reply.token) {
          closeAdminModal();
          // The wizard reads the short-lived unlock token from the fragment,
          // which never leaves the browser, and removes it from the address.
          window.location.href =
            `${AGENT_SETUP_URL}#${adminModalTarget}&admin=${encodeURIComponent(reply.token)}`;
        } else {
          if (adminErr) {
            adminErr.textContent = (reply && reply.error) || "Invalid administrator password.";
            adminErr.classList.remove("hidden");
          }
        }
      } catch (err) {
        if (adminErr) {
          adminErr.textContent = (err && err.message) || "Verification failed.";
          adminErr.classList.remove("hidden");
        }
      } finally {
        btnAdminSubmit.disabled = false;
      }
    }

    // The clock, in the workstation's own timezone -- which is the point: the
    // Language & Region step is what set it, and this is where it shows.
    const clockText = shadow.getElementById("kiosk-clock-text");
    const btnClock = shadow.getElementById("btn-clock");

    function renderClock() {
      if (!clockText) return;
      try {
        clockText.textContent = new Intl.DateTimeFormat(undefined, {
          weekday: "short", day: "2-digit", month: "short",
          hour: "2-digit", minute: "2-digit",
        }).format(new Date());
      } catch {
        clockText.textContent = new Date().toLocaleString();
      }
    }
    renderClock();
    setInterval(renderClock, 15000);

    if (btnClock) btnClock.onclick = () => openAdminModal("locale");

    if (btnNetwork) btnNetwork.onclick = () => openAdminModal("network");
    if (btnAdminCancel) btnAdminCancel.onclick = closeAdminModal;
    if (btnAdminSubmit) btnAdminSubmit.onclick = submitAdminPassword;
    if (adminInput) {
      adminInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitAdminPassword();
        } else if (e.key === "Escape") {
          e.preventDefault();
          closeAdminModal();
        }
      });
    }

    updateNavButtonStates(shadow);
    return shadow;
  }

  function updateNavButtonStates(shadow) {
    if (!shadow) return;
    const btnBack = shadow.getElementById("btn-back");
    if (!btnBack) return;
    if (isAtBroadcastRoot()) {
      btnBack.classList.add("disabled");
      btnBack.style.opacity = "0.35";
      btnBack.style.cursor = "not-allowed";
      btnBack.title = t("bar.back-is-disabled-at-the-start", "Back is disabled at the start of the broadcast lesson");
    } else {
      btnBack.classList.remove("disabled");
      btnBack.style.opacity = "1";
      btnBack.style.cursor = "pointer";
      btnBack.title = t("bar.backTitle", "Go Back");
    }
  }

  let shadowRoot = null;

  // 3. Periodic Synchronization with local agent
  async function syncLoop() {
    try {
      // A hostile or merely over-eager page can remove our host node; rebuild it
      // rather than silently losing the lock curtain for the rest of the session.
      if (!document.getElementById("labkiosk-root")) {
        shadowRoot = null;
      }
      if (!shadowRoot && document.documentElement) {
        shadowRoot = initKioskUi() || null;
      }

      const { status: data } = await askAgent({ type: "labkiosk:status" });

      if (shadowRoot) {
        const dot = shadowRoot.getElementById("kiosk-dot");
        const netIcon = shadowRoot.getElementById("kiosk-net-icon");
        const btnNet = shadowRoot.getElementById("btn-network");

        if (data && data.isOnline) {
          offlineSince = null;
          if (dot) dot.classList.remove("offline");
          if (netIcon) netIcon.setAttribute("stroke", "#10b981");
          if (btnNet) btnNet.title = t("bar.network-connected-click-to-configure", "Network Connected (Click to configure)");
        } else {
          if (offlineSince === null) offlineSince = Date.now();
          if (dot) dot.classList.add("offline");
          if (netIcon) netIcon.setAttribute("stroke", "#ef4444");
          if (btnNet) btnNet.title = t("bar.network-offline-click-to-configure", "Network Offline (Click to configure)");

          // Measured in time, not ticks: offline, a status call can take several
          // seconds, so ticks would stretch the grace period unpredictably. A
          // locked screen stays locked rather than jumping to the wizard.
          const offlineFor = Date.now() - offlineSince;
          if (offlineFor > OFFLINE_REDIRECT_MS && !isAgentPage(window.location.href) && !(data && data.isLocked)) {
            console.warn("[LabKiosk] Workstation offline for >6s, redirecting to network configuration");
            window.location.replace(`${AGENT_SETUP_URL}#offline`);
            return;
          }
        }

        // Client ID
        const cid = shadowRoot.getElementById("kiosk-client-id");
        if (cid && data.clientId) cid.textContent = data.clientId;

        // Lock Curtain & Bar Visibility
        const curtain = shadowRoot.getElementById("lock-curtain");
        const lockText = shadowRoot.getElementById("lock-text");
        const bar = shadowRoot.getElementById("kiosk-bar");
        if (curtain) {
          if (data.isLocked) {
            isLocked = true;
            curtain.classList.remove("hidden");
            if (bar) bar.classList.remove("visible");
            if (data.lockMessage && lockText) lockText.textContent = data.lockMessage;
          } else {
            isLocked = false;
            curtain.classList.add("hidden");
          }
        }

        updateNavButtonStates(shadowRoot);

        // Remote reload command detection by epoch change
        const srvReloadEpoch = Number(data.reloadEpoch || 0);
        if (lastReloadEpoch === null) {
          lastReloadEpoch = srvReloadEpoch;
        } else if (srvReloadEpoch > 0 && srvReloadEpoch !== lastReloadEpoch) {
          lastReloadEpoch = srvReloadEpoch;
          try {
            sessionStorage.setItem("labkiosk_reload_epoch", String(srvReloadEpoch));
          } catch {}
          window.location.reload();
          return;
        }

        // High-priority broadcast detection by epoch or target change
        const srvEpoch = String(data.broadcastEpoch || 0);
        const storedEpoch = broadcastState.epoch || "0";
        const isNewEpoch = srvEpoch !== "0" && srvEpoch !== storedEpoch;
        const targetChanged = data.targetUrl && lastTargetUrl && data.targetUrl !== lastTargetUrl;

        if (isNewEpoch || (targetChanged && data.broadcastUrl)) {
          const safeTarget = httpUrlOrNull(data.broadcastUrl || data.targetUrl);

          if (safeTarget) {
            await storeBroadcastState(srvEpoch, safeTarget);
            lastTargetUrl = data.targetUrl;
            if (normalizeUrl(window.location.href) !== normalizeUrl(safeTarget)) {
              window.location.replace(safeTarget);
              return;
            }
          }
        } else if (srvEpoch === "0" && storedEpoch !== "0") {
          // Broadcast session ended / reset by teacher.
          await clearBroadcastState();
          // The same protocol check as the branches above: targetUrl comes from
          // the control plane and ends up in location.replace(), so a
          // javascript: value here would run in whatever page the student is on.
          const safeTarget = httpUrlOrNull(data.targetUrl);
          if (safeTarget && normalizeUrl(window.location.href) !== normalizeUrl(safeTarget)) {
            window.location.replace(safeTarget);
            return;
          }
        } else if (data.targetUrl && lastTargetUrl && data.targetUrl !== lastTargetUrl) {
          const safeTarget = httpUrlOrNull(data.targetUrl);
          if (safeTarget && normalizeUrl(window.location.href) !== normalizeUrl(safeTarget)) {
            window.location.replace(safeTarget);
            return;
          }
        }
        lastTargetUrl = data.targetUrl;
      }
    } catch (e) {
      if (shadowRoot) {
        const dot = shadowRoot.getElementById("kiosk-dot");
        if (dot) dot.classList.add("offline");
        const netIcon = shadowRoot.getElementById("kiosk-net-icon");
        if (netIcon) netIcon.setAttribute("stroke", "#ef4444");
      }
    }
  }

  // Initialize
  function ensureKioskUi() {
    const root = initKioskUi();
    if (root) shadowRoot = root;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureKioskUi);
  } else {
    ensureKioskUi();
  }
  // Run one sync immediately so a locked screen stays locked across navigation
  // rather than flashing the page for a second first. The broadcast marker is
  // hydrated from the service worker first, so this tick does not mistake an
  // in-flight broadcast for a brand new one and redirect a second time.
  loadBroadcastState().then(syncLoop, syncLoop);

  setInterval(syncLoop, 1000);
})();
