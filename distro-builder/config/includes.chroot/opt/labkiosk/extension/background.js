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
