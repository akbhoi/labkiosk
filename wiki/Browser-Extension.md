# Browser Extension

`distro-builder/config/includes.chroot/opt/labkiosk/extension/` — an unpacked Manifest V3 Chromium extension supplying the kiosk's navigation bar, its status indicator, and the operator's lock curtain.

It is loaded with `--load-extension` at browser launch. Its ID is fixed to `hfjmbeplebjipenkfabncgkpadnjmmoe` by the public `key` in the manifest, which keeps storage and identity stable across rebuilds and is a prerequisite for ever force-installing it as a packed `.crx`.

---

## Why an extension at all

Approved platforms — Khan Academy, YouTube, Scratch — enforce `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`. Any kiosk that renders pages inside an `<iframe>` fails with `ERR_BLOCKED_BY_RESPONSE` on the sites operators most want to use.

So Lab Kiosk navigates **top-level, natively**, and injects its own chrome into the page instead. That gets full hardware acceleration and zero embedding failures, at the cost of needing an extension to put a nav bar on top.

---

## Two files, one boundary

```text
  page context                     extension context
+-------------------+           +---------------------------+
|    content.js     |  message  |      background.js        |
|  Shadow DOM UI    | --------> |  MV3 service worker       |
|  nav bar, curtain |  <------- |  host_permissions:        |
|  key/input traps  |           |   http://127.0.0.1:8888/* |
+-------------------+           +------------|--------------+
                                             |  fetch
                                             v
                                +---------------------------+
                                |  agent.py  /api/status    |
                                +---------------------------+
```

### The CORS boundary is the whole point

`content.js` runs in the visited page's origin. A `fetch()` from there to `http://127.0.0.1:8888` is cross-origin, and would require the agent to answer with `Access-Control-Allow-Origin: *`. The agent used to do exactly that — which meant **any site a user visited could talk to the local agent**.

A service-worker fetch is governed by the extension's `host_permissions` instead of the page's CORS. So `background.js` owns the loopback grant, `content.js` reaches it only through `chrome.runtime.sendMessage`, and the agent refuses cross-origin callers outright.

**`content.js` must never fetch the agent directly.** That is an architectural invariant, not a style preference.

One consequence is easy to trip over. Chromium attaches `Origin: chrome-extension://<id>` to every
non-`GET` fetch from the service worker, so the administrator modal's `POST /api/admin/verify`
does not look like a loopback caller — the agent answered *"Cross-origin requests are not
accepted"* until it was taught this one extra origin. `GET`s carry no `Origin` at all, which is
why the online/offline indicator kept working while the modal did not. The agent matches the
extension's pinned id (`KIOSK_EXTENSION_ORIGIN`), never the `chrome-extension:` scheme, and it
names any other rejected origin in its log.

### Broadcast state lives in extension storage

The active broadcast epoch and URL are held in `chrome.storage.session` under `labkiosk_broadcast`, owned by the service worker.

They used to live in the visited page's own `sessionStorage`, where that page's scripts could rewrite them — to sit out an operator's broadcast, or to re-enable Back at the broadcast root. Extension storage is in the extension's partition, unreachable from page script, and `session` keeps the per-boot lifetime the kiosk wants while surviving both page navigation and the service worker being torn down when idle.

`writeBroadcast()` stores only an `http(s)` URL, because that value is handed back to the content script and becomes a `location.replace()` target.

---

## The navigation bar

A 44 px header injected into the top frame at `document_start`, inside a **closed** Shadow DOM:

```js
const shadow = host.attachShadow({ mode: "closed" });
```

Closed matters: a closed shadow root is not reachable from the host element, so page script cannot query, restyle, or tear the kiosk UI out from under the operator. The only handles are the two the content script keeps privately.

**Auto-hide.** The bar sits at `transform: translateY(-100%)` and slides to `translateY(0)` only when the pointer enters the top 12 pixels (`e.clientY <= 12`). The page therefore occupies 100 % of the viewport with zero vertical scroll overflow.

**Never modify `document.body.style.marginTop`.** Reserving space for the bar breaks full-height layouts on real sites and reintroduces a scrollbar the kiosk does not want.

Controls: Home, Back, Forward, Reload, domain pill, and `.client-meta` housing the network status icon (`#btn-network`), connection status dot (`#kiosk-dot`), and client ID. Navigation is done entirely with the History API in the content script and never touches the agent, so there is no navigation channel to the loopback API at all.

---

## Network management & administrator modal

In addition to navigation buttons, the top bar includes an interactive network indicator (`#btn-network`):

- **Visual status:** SVG network icon renders with a green stroke (`#10b981`) when online and red (`#ef4444`) when offline.
- **Discoverability:** the bar slides into view for 2.5 seconds on the first page of each session, then hides itself. A bar that only appears when the pointer reaches the top edge is otherwise invisible to anyone who has not been told about it. The service worker hands out the one-shot flag (`labkiosk:intro-peek`, stored in `chrome.storage.session`), so it happens once per boot rather than on every navigation.
- **Admin Authentication Modal (`#admin-modal`):** Because users must not tamper with network routes or IPs during class or assessments, clicking `#btn-network` renders an isolated password prompt inside the Shadow DOM.
- **Verification Bridge:** Entering the boot/admin password dispatches `askAgent({ type: "labkiosk:verify-admin", password })` to `background.js`, which invokes the agent's `/api/admin/verify`.
- **Navigation:** Upon successful verification, the browser navigates to `http://127.0.0.1:8888/setup#network&admin=<token>`. The wizard keeps the short-lived token in memory and strips it from the address bar, so the password is asked only once.

---

## The lock curtain

When the operator sends `lock`, the agent records it and `content.js` — polling `/api/status` through the service worker once a second — raises a full-screen overlay with the operator's message.

While the curtain is up, these events are swallowed at the window level in the capture phase:

```text
click  dblclick  mousedown  mouseup  wheel
keydown  keypress  keyup
touchstart  touchmove  touchend
```

Events whose `composedPath()` includes `#labkiosk-root` are let through, so the curtain itself and the admin verification modal keep working; everything else is discarded with `preventDefault()` and `stopImmediatePropagation()`.

> This is a **DOM-level block, not an X11 input grab.** It stops the user interacting with the page. Browser- and window-level shortcuts are covered by different layers: Chromium's `--kiosk` switches, the blocked `chrome://` scheme, and Openbox's emptied keybinding table. → [Kiosk Hardening](Kiosk-Hardening)

Independently of the curtain, the content script suppresses `F12`, `Ctrl+Shift+I/J/C`, `Ctrl+U`, `F11`, right-click, and — at the broadcast root only — `Alt+Left` and `Backspace`, so a user cannot reverse out of the page the operator pushed.

---

## The sync loop

```js
setInterval(syncLoop, 1000);
```

Once a second the content script asks the service worker for the agent's status and reconciles:

- **Lock curtain:** curtain up or down, message text.
- **Broadcast synchronization:** broadcast navigation when the epoch has advanced.
- **Online/Offline status:** Updates `#kiosk-dot` and `#kiosk-net-icon`.
- **Offline Auto-Fallback:** If `data.isOnline` stays false for more than 6 seconds (measured in time, not polls) on a non-loopback, unlocked page, the content script redirects the browser to `http://127.0.0.1:8888/setup#offline`, which returns to the page by itself once the connection is back. This allows lab technicians to remediate Wi-Fi/Ethernet disconnects immediately without rebooting or opening a terminal.

Failures are handled deliberately rather than swallowed — an early version let a transient error leave the status dot green while the lock curtain never appeared again.

---

## Do not add a blanket extension block

The managed Chromium policy deliberately contains **no** `ExtensionInstallBlocklist: ["*"]` and no `*` entry in `ExtensionSettings`. With one, Chromium refuses `--load-extension` entirely and logs *"Loading of unpacked extensions is disabled by the administrator"* — silently removing the kiosk's own navigation bar and lock curtain. An `ExtensionInstallAllowlist` entry does **not** override it; this was tried and verified.

Users cannot install extensions regardless:

- `chrome://*` is blocklisted, so the extensions page is unreachable;
- the browser runs in `--kiosk` with no UI;
- the Chrome Web Store is not in `URLAllowlist`;
- the profile directory is deleted on every launch.

If a blanket block ever becomes necessary, pack the kiosk extension as a `.crx` first and force-install it by ID.

---

## Developing and testing

Manifest V3 extensions are parsed at browser launch, so changes need a Chromium restart rather than an agent restart:

```bash
# Push your edits into the running simulator
docker cp distro-builder/config/includes.chroot/opt/labkiosk/extension \
  labkiosk-client-01:/opt/labkiosk/

# Restart Chromium; the watchdog relaunches it within a second
docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile

# Verify on screen, not in a log line
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png
docker cp labkiosk-client-01:/tmp/verify.png .
```

Syntax check, which CI also runs:

```bash
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
```

**Never claim a UI change is complete without looking at a screenshot.** The agent logging a command as executed proves only that the agent ran; it does not prove the user saw anything.

→ [Client Agent](Client-Agent) · [Kiosk Hardening](Kiosk-Hardening) · [Workstation Simulator](Workstation-Simulator)
