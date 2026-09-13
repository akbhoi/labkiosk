/**
 * Lab Kiosk Web Wrapper Controller
 * Manages locked navigation, local agent synchronization, and lockdown curtain.
 */

const LOCAL_AGENT_BASE = "http://127.0.0.1:8888";
const DEFAULT_HOMEPAGE = "https://www.khanacademy.org";

// Elements
const contentFrame = document.getElementById("content-frame");
const btnHome = document.getElementById("btn-home");
const btnBack = document.getElementById("btn-back");
const btnForward = document.getElementById("btn-forward");
const btnReload = document.getElementById("btn-reload");
const activeUrlDisplay = document.getElementById("active-url-display");
const syncDot = document.getElementById("sync-dot");
const clientIdBadge = document.getElementById("client-id-badge");
const lockCurtain = document.getElementById("lock-curtain");
const lockMessage = document.getElementById("lock-message");
const kioskHeader = document.getElementById("kiosk-header");
const kioskSensor = document.getElementById("kiosk-sensor");

// State
let currentHomepage = DEFAULT_HOMEPAGE;
let currentActiveUrl = DEFAULT_HOMEPAGE;
let isLocked = false;
let isAgentConnected = false;
let headerHideTimer = null;

function showHeader() {
  if (isLocked) return;
  if (headerHideTimer) {
    clearTimeout(headerHideTimer);
    headerHideTimer = null;
  }
  if (kioskHeader) kioskHeader.classList.add("visible");
}

function hideHeader(delay = 400) {
  if (headerHideTimer) clearTimeout(headerHideTimer);
  headerHideTimer = setTimeout(() => {
    if (kioskHeader && !kioskHeader.matches(":hover")) {
      kioskHeader.classList.remove("visible");
    }
  }, delay);
}

if (kioskSensor) kioskSensor.addEventListener("mouseenter", showHeader);
if (kioskHeader) {
  kioskHeader.addEventListener("mouseenter", () => {
    if (headerHideTimer) {
      clearTimeout(headerHideTimer);
      headerHideTimer = null;
    }
  });
  kioskHeader.addEventListener("mouseleave", () => hideHeader(300));
}

window.addEventListener(
  "mousemove",
  (e) => {
    if (e.clientY <= 12) {
      showHeader();
    } else if (e.clientY > 55) {
      if (kioskHeader && kioskHeader.classList.contains("visible") && !kioskHeader.matches(":hover")) {
        hideHeader(300);
      }
    }
  },
  { passive: true }
);

window.addEventListener("mouseleave", () => hideHeader(200));

// Block right-click and keyboard tampering
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("keydown", (e) => {
  // Prevent F12, Ctrl+Shift+I, Ctrl+U, Ctrl+R, F5 (let UI handle reload)
  if (
    e.key === "F12" ||
    (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J" || e.key === "C")) ||
    (e.ctrlKey && (e.key === "u" || e.key === "U")) ||
    e.key === "F11"
  ) {
    e.preventDefault();
  }
});

// Navigation Handlers
async function sendNavAction(action) {
  try {
    await fetch(`${LOCAL_AGENT_BASE}/api/nav`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
  } catch (err) {
    console.warn("Local agent offline for native nav action:", err);
  }
}

btnHome.addEventListener("click", () => {
  navigateTo(currentHomepage);
});

btnBack.addEventListener("click", () => {
  sendNavAction("back");
  try {
    contentFrame.contentWindow.history.back();
  } catch (e) {
    // Cross-origin fallback handled by native agent xdotool
  }
});

btnForward.addEventListener("click", () => {
  sendNavAction("forward");
  try {
    contentFrame.contentWindow.history.forward();
  } catch (e) {
    // Cross-origin fallback handled by native agent xdotool
  }
});

btnReload.addEventListener("click", () => {
  sendNavAction("reload");
  try {
    contentFrame.contentWindow.location.reload();
  } catch (e) {
    contentFrame.src = contentFrame.src;
  }
});

function navigateTo(url) {
  if (!url || url === contentFrame.src) return;
  currentActiveUrl = url;
  contentFrame.src = url;
  try {
    const parsed = new URL(url);
    activeUrlDisplay.textContent = parsed.hostname + (parsed.pathname.length > 1 ? parsed.pathname : "");
  } catch (e) {
    activeUrlDisplay.textContent = url;
  }
}

// Poll local Python agent for state & commands
async function syncWithAgent() {
  try {
    const res = await fetch(`${LOCAL_AGENT_BASE}/api/status`, { cache: "no-store" });
    if (!res.ok) throw new Error("Agent response not OK");
    const data = await res.json();

    // 1. Connection Status
    if (!isAgentConnected) {
      isAgentConnected = true;
      syncDot.classList.add("online");
      syncDot.classList.remove("offline");
    }

    // 2. Client ID
    if (data.clientId && clientIdBadge.textContent !== data.clientId) {
      clientIdBadge.textContent = data.clientId;
    }

    // 3. Homepage & Target URL
    if (data.targetUrl && data.targetUrl !== currentActiveUrl) {
      currentHomepage = data.targetUrl;
      navigateTo(data.targetUrl);
    }

    // 4. Lock Curtain
    if (data.isLocked !== isLocked) {
      isLocked = data.isLocked;
      if (isLocked) {
        if (data.lockMessage) lockMessage.textContent = data.lockMessage;
        lockCurtain.classList.remove("hidden");
        if (kioskHeader) kioskHeader.classList.remove("visible");
      } else {
        lockCurtain.classList.add("hidden");
      }
    }
  } catch (err) {
    isAgentConnected = false;
    syncDot.classList.remove("online");
    syncDot.classList.add("offline");
  }
}

// Initial Boot
navigateTo(DEFAULT_HOMEPAGE);
setInterval(syncWithAgent, 1000);
syncWithAgent();
