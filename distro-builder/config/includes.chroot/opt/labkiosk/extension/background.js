/**
 * Lab Kiosk extension service worker.
 *
 * The only reason this exists is CORS. The lock curtain and navigation bar live
 * in a content script, which runs in the page's origin -- so its fetches to the
 * local agent (http://127.0.0.1:8888) are cross-origin and would need the agent
 * to answer with `Access-Control-Allow-Origin: *`. The agent used to do exactly
 * that, which meant any site a user visited could talk to it.
 *
 * A service-worker fetch is governed by the extension's host_permissions instead
 * of the page's CORS, so the agent can refuse cross-origin callers entirely
 * while the kiosk UI still reads its state.
 *
 * It also owns the active broadcast marker (`labkiosk:broadcast-get` /
 * `labkiosk:broadcast-set`). That used to live in the visited page's own
 * sessionStorage, which meant the page could rewrite it to sit out an operator's
 * broadcast or re-enable Back at the broadcast root. chrome.storage.session
 * keeps it in the extension's partition -- unreachable from page script, still
 * wiped at every boot -- and surviving both page navigation and this service
 * worker being torn down when idle.
 *
 * Navigation (back, forward, reload, home) is done by the content script with
 * the History API and never needs the agent, so there is no nav channel to the
 * agent's loopback API.
 */

const AGENT_STATUS_URL = "http://127.0.0.1:8888/api/status";
const BROADCAST_KEY = "labkiosk_broadcast";
const EMPTY_BROADCAST = { epoch: "0", url: "" };

async function readStatus() {
  const res = await fetch(AGENT_STATUS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Agent responded ${res.status}`);
  return await res.json();
}

async function readBroadcast() {
  const stored = await chrome.storage.session.get(BROADCAST_KEY);
  const value = stored && stored[BROADCAST_KEY];
  if (!value || typeof value.epoch !== "string") return { ...EMPTY_BROADCAST };
  return { epoch: value.epoch, url: typeof value.url === "string" ? value.url : "" };
}

async function writeBroadcast(epoch, url) {
  // Only ever store an http(s) URL: this value is handed back to the content
  // script and becomes a location.replace() target.
  let safeUrl = "";
  try {
    if (url) {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        safeUrl = parsed.href;
      }
    }
  } catch {
    safeUrl = "";
  }
  const value = { epoch: String(epoch || "0"), url: safeUrl };
  await chrome.storage.session.set({ [BROADCAST_KEY]: value });
  return value;
}

const BAR_INTRO_KEY = "labkiosk_bar_intro";

/**
 * True exactly once per browser session, for the first page that asks.
 *
 * The navigation bar auto-hides, so a user who has never seen it has no way
 * to discover it. It is shown briefly at the start of a session; the flag lives
 * here rather than in the content script because that runs afresh on every
 * page, and in chrome.storage.session so it resets when the kiosk reboots.
 */
async function claimBarIntro() {
  const stored = await chrome.storage.session.get(BAR_INTRO_KEY);
  if (stored && stored[BAR_INTRO_KEY]) return { first: false };
  await chrome.storage.session.set({ [BAR_INTRO_KEY]: true });
  return { first: true };
}

const AGENT_I18N_URL = "http://127.0.0.1:8888/i18n/";
const I18N_KEY = "labkiosk_catalog";

/**
 * The interface catalog for the language chosen in the setup wizard.
 *
 * Cached in chrome.storage.session because content.js runs again on every page
 * a user opens, and the bar must not fetch a catalog each time. The cache
 * lasts exactly as long as the boot does, which is also how long the chosen
 * language can change without a restart.
 */
async function readCatalog() {
  const cached = await chrome.storage.session.get(I18N_KEY);
  if (cached && cached[I18N_KEY]) return cached[I18N_KEY];

  let catalog = {};
  try {
    const status = await readStatus();
    const tag = (status && status.uiLanguage) || "en-US";
    if (tag && tag !== "en-US") {
      const res = await fetch(AGENT_I18N_URL + encodeURIComponent(tag) + ".json", { cache: "no-store" });
      if (res.ok) catalog = await res.json();
    }
  } catch {
    // English is already in the markup; a missing catalog changes nothing.
    catalog = {};
  }
  await chrome.storage.session.set({ [I18N_KEY]: catalog });
  return catalog;
}

const AGENT_ADMIN_VERIFY_URL = "http://127.0.0.1:8888/api/admin/verify";
const AGENT_NETWORK_STATUS_URL = "http://127.0.0.1:8888/api/network/status";

async function verifyAdmin(password) {
  const res = await fetch(AGENT_ADMIN_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: String(password || "") }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    throw new Error(`Admin verification failed (${res.status})`);
  }
  // 401 (wrong password), 429 (throttled) and 500 (unreadable password file)
  // all carry a message the modal should show as-is.
  if (!res.ok) {
    return { verified: false, error: body.error || `Admin verification failed (${res.status})` };
  }
  return body;
}

async function readNetworkStatus() {
  const res = await fetch(AGENT_NETWORK_STATUS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Network status error (${res.status})`);
  return await res.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  const reply = (promise) => {
    promise
      .then((value) => sendResponse({ ok: true, ...value }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // keep the message channel open for the async reply
  };

  if (message.type === "labkiosk:status") {
    return reply(readStatus().then((status) => ({ status })));
  }

  if (message.type === "labkiosk:i18n") {
    return reply(readCatalog().then((catalog) => ({ catalog })));
  }

  if (message.type === "labkiosk:verify-admin") {
    return reply(verifyAdmin(message.password));
  }

  if (message.type === "labkiosk:network-status") {
    return reply(readNetworkStatus().then((network) => ({ network })));
  }

  if (message.type === "labkiosk:intro-peek") {
    return reply(claimBarIntro());
  }

  if (message.type === "labkiosk:broadcast-get") {
    return reply(readBroadcast().then((broadcast) => ({ broadcast })));
  }

  if (message.type === "labkiosk:broadcast-set") {
    return reply(
      writeBroadcast(message.epoch, message.url).then((broadcast) => ({ broadcast }))
    );
  }

  if (message.type === "labkiosk:broadcast-clear") {
    return reply(
      chrome.storage.session.remove(BROADCAST_KEY).then(() => ({ broadcast: { ...EMPTY_BROADCAST } }))
    );
  }

  return false;
});

/*
 * Never leave the kiosk on a page the bar cannot appear on.
 *
 * A page the managed policy blocks, and a page that fails to load, are shown by
 * Chromium as chrome-error:// pages, and no extension runs there: no bar, no
 * network icon, no clock, and no way back to the setup pages -- which is how a
 * workstation whose organization had been deleted ended up stranded on "This
 * page is blocked". Such a top-level failure is sent to a page on the agent's
 * origin instead, where content.js builds the bar as everywhere else.
 */
const AGENT_ORIGIN = "http://127.0.0.1:8888";
const BLOCKED_PAGE_URL = `${AGENT_ORIGIN}/blocked`;
const OFFLINE_PAGE_URL = `${AGENT_ORIGIN}/setup#offline`;

// Failures that mean "no network" rather than "this site": the wizard's offline
// page shows the connection state and returns to the lesson once it is back.
const NETWORK_ERRORS = new Set([
  "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_NAME_RESOLUTION_FAILED",
  "net::ERR_ADDRESS_UNREACHABLE",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_CLOSED",
  "net::ERR_CONNECTION_FAILED",
  "net::ERR_CONNECTION_TIMED_OUT",
  "net::ERR_TIMED_OUT",
  "net::ERR_PROXY_CONNECTION_FAILED",
  "net::ERR_TUNNEL_CONNECTION_FAILED"
]);

/**
 * Where a failed top-level navigation should go instead, or null to leave it.
 * `isOnline` is the agent's view: a DNS or connection failure while the
 * workstation is online means that one site is down, and the offline page --
 * which returns to the lesson once it sees a connection -- would bounce straight
 * back to the dead site and loop.
 */
function recoveryUrlFor(details, isOnline) {
  if (details.frameId !== 0) return null; // a failed iframe leaves its page usable
  let failed;
  try {
    failed = new URL(details.url);
  } catch {
    return null;
  }
  // The agent's own pages are where recovery happens; never redirect away from
  // them, or a failure there would loop.
  if (failed.origin === AGENT_ORIGIN) return null;
  if (details.error === "net::ERR_BLOCKED_BY_ADMINISTRATOR") {
    // The full address too, so the page can try it once more: a broadcast adds
    // its site to the allowlist in the same heartbeat that sends the screen
    // there, and Chromium only rereads a changed policy after a few seconds.
    // The agent never logs request paths, so this goes nowhere else.
    return `${BLOCKED_PAGE_URL}?host=${encodeURIComponent(failed.hostname)}&url=${encodeURIComponent(failed.href)}`;
  }
  if (NETWORK_ERRORS.has(details.error)) {
    if (!isOnline) return OFFLINE_PAGE_URL;
    return `${BLOCKED_PAGE_URL}?reason=unreachable&host=${encodeURIComponent(failed.hostname)}&url=${encodeURIComponent(failed.href)}`;
  }
  return null; // ERR_ABORTED (a cancelled navigation) and the like
}

chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId !== 0) return;
  let isOnline = false;
  if (NETWORK_ERRORS.has(details.error)) {
    try {
      isOnline = Boolean((await readStatus()).isOnline);
    } catch (err) {
      // The agent itself did not answer: treat it as offline, whose page is
      // the one that knows how to wait for the connection.
      isOnline = false;
    }
  }
  const target = recoveryUrlFor(details, isOnline);
  if (!target) return;
  chrome.tabs.update(details.tabId, { url: target }).catch((err) => {
    console.warn("Could not leave the error page:", err);
  });
});
