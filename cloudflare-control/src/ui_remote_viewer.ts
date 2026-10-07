/**
 * The Remote Control viewer: noVNC on the console's own address, connected to a
 * workstation through the relay (src/remote_relay.ts). The Workstations page
 * shows it in its Remote Control frame.
 *
 * noVNC is served from this Worker's static assets (`/novnc/`, staged from the
 * pinned `@novnc/novnc` package by scripts/stage-novnc.mjs). The workstation's
 * per-boot VNC password arrives in the fragment, which a browser never sends,
 * and is removed from the address before anything else runs.
 */

import { escapeAttr, escapeHtml } from "./escape";
import { FONT_LINKS, rootTokensCss } from "./ui_tokens";
import { RELAY_PING } from "./remote_relay";
import { FAVICON_LINK_HTML } from "./seo";

/** Where the staged noVNC client is served from. */
export const NOVNC_PATH = "/novnc/";

export function renderRemoteViewerHtml(options: { clientId: string; nonce: string }): string {
  const { clientId, nonce } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex, nofollow">
  <title>Remote Control: ${escapeHtml(clientId)}</title>
${FAVICON_LINK_HTML}${FONT_LINKS}
  <style>
${rootTokensCss()}
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: flex;
      flex-direction: column;
      font-family: var(--font-sans);
      background: var(--bg-base);
      color: var(--text-main);
    }
    .viewer-screen { flex: 1; min-height: 0; overflow: hidden; }
    .viewer-status {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      background: var(--bg-base);
      color: var(--text-muted);
      font-size: 0.9375rem;
      line-height: 1.6;
    }
    .viewer-status[hidden] { display: none; }
    .tone-error { color: var(--danger-text); }
  </style>
</head>
<body>
  <div id="screen" class="viewer-screen" data-client-id="${escapeAttr(clientId)}"></div>
  <div id="status" class="viewer-status" role="status" aria-live="polite">Connecting…</div>
  <script type="module" nonce="${escapeAttr(nonce)}">
    import RFB from "${NOVNC_PATH}core/rfb.js";

    const PING = ${JSON.stringify(RELAY_PING)};
    const KEEPALIVE_MS = 30000;
    const screen = document.getElementById("screen");
    const statusLine = document.getElementById("status");
    const clientId = screen.dataset.clientId;
    const params = new URLSearchParams(window.location.search);
    const tenant = params.get("tenant");
    const password = new URLSearchParams(window.location.hash.slice(1)).get("password") || "";
    history.replaceState(null, "", window.location.pathname + window.location.search);

    function show(text, isError) {
      statusLine.textContent = text;
      statusLine.classList.toggle("tone-error", Boolean(isError));
      statusLine.hidden = false;
    }

    function api(path) {
      return tenant ? path + "?tenant=" + encodeURIComponent(tenant) : path;
    }

    // noVNC takes any channel with a WebSocket's shape. This one keeps an idle
    // session open with a small text ping, which the relay answers itself, and
    // hands noVNC only the VNC bytes.
    class KeptAliveChannel {
      constructor(socket) {
        this.socket = socket;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        socket.binaryType = "arraybuffer";
        socket.onopen = (event) => { if (this.onopen) this.onopen(event); };
        socket.onmessage = (event) => {
          if (typeof event.data === "string") return;
          if (this.onmessage) this.onmessage(event);
        };
        socket.onerror = (event) => { if (this.onerror) this.onerror(event); };
        socket.onclose = (event) => {
          clearInterval(this.timer);
          if (this.onclose) this.onclose(event);
        };
        this.timer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(PING);
        }, KEEPALIVE_MS);
      }
      get readyState() { return this.socket.readyState; }
      get protocol() { return this.socket.protocol; }
      get binaryType() { return this.socket.binaryType; }
      set binaryType(value) { this.socket.binaryType = value; }
      send(data) { this.socket.send(data); }
      close(code, reason) { this.socket.close(code, reason); }
    }

    async function start() {
      show("Asking " + clientId + " to connect…");
      let data;
      try {
        const res = await fetch(api("/api/clients/remote-session"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId })
        });
        data = await res.json();
        if (!res.ok) {
          show(data.error || "Remote Control could not be opened.", true);
          return;
        }
      } catch (err) {
        show("Network error: " + err.message, true);
        return;
      }
      const scheme = window.location.protocol === "https:" ? "wss://" : "ws://";
      const socket = new WebSocket(scheme + window.location.host + data.socketPath);
      let closeReason = "";
      socket.addEventListener("close", (event) => { closeReason = event.reason || ""; });
      const rfb = new RFB(screen, new KeptAliveChannel(socket), { credentials: { password } });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.addEventListener("connect", () => { statusLine.hidden = true; rfb.focus(); });
      rfb.addEventListener("credentialsrequired", () => {
        show("The workstation asked for a VNC password the console does not have yet. Close this and try again in a few seconds.", true);
      });
      rfb.addEventListener("securityfailure", (event) => {
        show("The workstation refused the VNC password" + (event.detail.reason ? ": " + event.detail.reason : "."), true);
      });
      rfb.addEventListener("disconnect", (event) => {
        if (event.detail.clean && !closeReason) {
          show("Remote Control ended.");
        } else {
          show(closeReason || "The connection to " + clientId + " was lost.", !event.detail.clean);
        }
      });
      setTimeout(() => {
        if (!statusLine.hidden && socket.readyState === WebSocket.OPEN && statusLine.textContent.startsWith("Asking")) {
          show("Waiting for " + clientId + " to answer. Its agent may be offline or too old for Remote Control through the console.");
        }
      }, (data.joinSeconds || 60) * 500);
    }

    start();
  </script>
</body>
</html>`;
}
