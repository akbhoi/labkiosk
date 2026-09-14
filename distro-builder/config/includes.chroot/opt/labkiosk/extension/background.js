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
 *
 * The only message is `labkiosk:status`. Navigation (back, forward, reload,
 * home) is done by the content script with the History API and never needs
 * the agent, so there is no nav channel to the agent's loopback API.
 */

const AGENT_STATUS_URL = "http://127.0.0.1:8888/api/status";

async function readStatus() {
  const res = await fetch(AGENT_STATUS_URL, { cache: "no-store" });
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

  return false;
});
