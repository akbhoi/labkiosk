/**
 * Lab Kiosk Navigation Bar & Lockdown Content Script
 * Injected into top-level pages to provide locked navigation controls,
 * real-time telemetry indicators, and fullscreen lock curtain.
 */

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
      return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase();
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
    if (existing && existing !== uiHost) {
      // Something replaced our host node; ours is gone, so start over.
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
          pointer-events: auto;
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
        }

        .client-meta {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          font-weight: 600;
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
          <button class="kiosk-btn" id="btn-home" title="Lesson Home">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
            Home
          </button>
          <button class="kiosk-btn" id="btn-back" title="Go Back">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Back
          </button>
          <button class="kiosk-btn" id="btn-forward" title="Go Forward">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
            Forward
          </button>
          <button class="kiosk-btn" id="btn-reload" title="Reload Page">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            Reload
          </button>
        </div>

        <div class="domain-pill">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
          <span id="kiosk-domain"></span>
        </div>

        <div class="client-meta">
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
      btnBack.title = "Back is disabled at the start of the broadcast lesson";
    } else {
      btnBack.classList.remove("disabled");
      btnBack.style.opacity = "1";
      btnBack.style.cursor = "pointer";
      btnBack.title = "Go Back";
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
        // Dot status
        const dot = shadowRoot.getElementById("kiosk-dot");
        if (dot) dot.classList.remove("offline");

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
