/**
 * Lab Kiosk extension service worker.
 *
 * The only reason this exists is CORS. The lock curtain and navigation bar live
 * in a content script, which runs in the page's origin -- so its fetches to the
 * local agent (http://127.0.0.1:8888) are cross-origin and would need the agent
 * to answer with `Access-Control-Allow-Origin: *`. The agent used to do exactly
 * that, which meant any site a student visited could talk to it.
 *
 * A service-worker fetch is governed by the extension's host_permissions instead
 * of the page's CORS, so the agent can refuse cross-origin callers entirely
 * while the kiosk UI still reads its state.
 */

const AGENT_STATUS_URL = "http://127.0.0.1:8888/api/status";
const AGENT_NAV_URL = "http://127.0.0.1:8888/api/nav";

async function readStatus() {
  const res = await fetch(AGENT_STATUS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Agent responded ${res.status}`);
  return await res.json();
}

async function sendNav(action) {
  const res = await fetch(AGENT_NAV_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action })
  });
  if (!res.ok) throw new Error(`Agent responded ${res.status}`);
  return await res.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "labkiosk:status") {
    readStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // keep the message channel open for the async reply
  }

  if (message.type === "labkiosk:nav") {
    sendNav(message.action)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  return false;
});
