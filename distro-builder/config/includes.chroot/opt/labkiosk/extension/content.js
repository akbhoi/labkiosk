/**
 * Lab Kiosk Navigation Bar & Lockdown Content Script
 * Injected into top-level pages to provide locked navigation controls,
 * real-time telemetry indicators, and fullscreen lock curtain.
 */

(function () {
  // Only inject in top window (never in sub-iframes)
  if (window.self !== window.top) return;

  const LOCAL_AGENT_API = "http://127.0.0.1:8888/api/status";
  let lastTargetUrl = null;
  let isLocked = false;

  // 1. Block right click and inspection shortcuts
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
      }
    },
    true
  );

  // 2. Create Isolated Shadow DOM Container for Top Bar & Curtain
  function initKioskUi() {
    if (document.getElementById("labkiosk-root")) return;

    const host = document.createElement("div");
    host.id = "labkiosk-root";
    host.style.cssText = "all: initial; position: absolute; z-index: 2147483647;";

    const shadow = host.attachShadow({ mode: "open" });
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
          <span id="kiosk-domain">${window.location.hostname || "Educational Resource"}</span>
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
          <p class="lock-msg" id="lock-text">Screens are locked by the teacher. Please look to the front.</p>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);

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
        const res = await fetch(LOCAL_AGENT_API);
        const data = await res.json();
        window.location.href = data.targetUrl || "https://www.khanacademy.org";
      } catch (e) {
        window.location.href = "https://www.khanacademy.org";
      }
    };
    shadow.getElementById("btn-back").onclick = () => window.history.back();
    shadow.getElementById("btn-forward").onclick = () => window.history.forward();
    shadow.getElementById("btn-reload").onclick = () => window.location.reload();

    return shadow;
  }

  let shadowRoot = null;

  // 3. Periodic Synchronization with local agent
  async function syncLoop() {
    try {
      if (!shadowRoot && document.body) {
        shadowRoot = initKioskUi();
      }

      const res = await fetch(LOCAL_AGENT_API, { cache: "no-store" });
      if (!res.ok) throw new Error("Agent not responding");
      const data = await res.json();

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

        // Navigate on broadcast URL
        if (data.targetUrl && lastTargetUrl && data.targetUrl !== lastTargetUrl) {
          if (window.location.href !== data.targetUrl && !window.location.href.startsWith(data.targetUrl)) {
            window.location.href = data.targetUrl;
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
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      shadowRoot = initKioskUi();
    });
  } else {
    shadowRoot = initKioskUi();
  }

  setInterval(syncLoop, 1000);
})();
