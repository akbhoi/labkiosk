---
name: labkiosk-core
description: Cross-cutting Lab Kiosk contracts between the workstation agent and the Cloudflare Worker — the control channel (OrgHub WebSocket, HTTP heartbeat fallback), enrolment, the remote command set (lock, navigate, clear-session…), broadcast state, remote control (VNC/tunnel), organizationName. Use for full-stack changes that touch both the client and the Worker, when changing what the agent sends or the Worker answers, or when routing a task to the right Lab Kiosk skill.
---

# Lab Kiosk — cross-cutting contracts

Lab Kiosk turns any computer into a locked-down browser workstation for an **organization**
(company, public body, library or school). Two subsystems talk over authenticated HTTPS:

- **Client OS** (`distro-builder/`): Debian 12 live/installed image, Python agent `agent.py` on
  `127.0.0.1:8888`, MV3 extension, setup wizard, disk installer. Codex: `distro-builder/AGENTS.md`.
- **Control plane** (`cloudflare-control/`): Cloudflare Worker + D1. Codex: `cloudflare-control/AGENTS.md`.

The codices are authoritative; this skill is the contract between them.

## Which skill for which task

| Task | Skill |
|---|---|
| Worker routes, guards, tenancy, staff, batch commands | `labkiosk-control` |
| Any page the Worker renders (consoles, landing, portal, legal, org homepage) | `labkiosk-console-ui` |
| Database schema, migrations | `labkiosk-d1-schema` |
| `agent.py`, extension, wizard, localization, keyboard lockdown | `labkiosk-client` |
| ISO build, packages, bootloaders, installer, overlay | `labkiosk-distro` |
| Trying client changes in Docker | `labkiosk-simulator` |

## 1. The control channel — WebSocket `GET /api/devices/ws`, HTTP `POST /api/telemetry` as fallback

Every organization has one **OrgHub** Durable Object (`src/org_hub.ts`, named by tenant id). It
holds who is connected, the command queue and the sockets; D1 is the registry it writes back to.
Both routes are answered before sessions and tenant resolution (`handleWorkstationRequest()`).

- Auth on both: `Authorization: Bearer <device_token>`. The token, never the body, decides the
  tenant and client id (`requireDevice()`, verified tokens cached per isolate for 60 s). A refused
  token is `401`/`403` on the handshake or the POST.
- **WebSocket** (`agent.py` `ControlChannel`, needs `python3-websocket`):
  - hub → workstation: `{"type":"config", whitelist, mode, targetUrl, broadcastUrl, broadcastEpoch,
    commands?}` on connect and on every admin change (`notifyConfigChanged()`);
    `{"type":"commands", commands}`; `{"type":"frames", on, intervalSeconds}` — frames are asked for
    only while a console is showing that screen; `{"type":"pong"}`.
  - workstation → hub: `{"type":"status", clientNum, activeUrl, isLocked, vncPassword?, remoteHost?}`
    on connect and on change; `{"type":"frame", thumbnail}` while asked; and the ping, which must be
    **byte-for-byte** `{"type":"ping"}` (`WEBSOCKET_PING` = `HUB_PING`): the edge answers it without
    waking the hub. `json.dumps` adds a space and would bill every ping. Sent every 15 s; the hub
    closes a socket silent for 75 s.
  - Close codes: `4001` removed, `4003` organization not active (→ `mark_enrolment_rejected()`),
    `4000` replaced by a newer connection (back off), `4008` stale (reconnect).
  - Handshake `404`/`426`/`501`, or three failed connects in a row → HTTP for 10 minutes.
- **HTTP heartbeat** (every 3 s; older agents and the fallback): payload `clientNum`, `activeUrl`,
  `isLocked`, `thumbnail`, `vncPassword`, `remoteHost` (`post_telemetry()` is the reference); reply
  `whitelist`, `targetUrl`, `commands`, `broadcastUrl` / `broadcastEpoch`. Both transports apply
  the reply through one function, `apply_control_update()`.
- `thumbnail`/frame: base64 JPEG from `scrot -t 20 -q 35`, **dropped** above 256 KB
  (`MAX_THUMBNAIL_BYTES` = `MAX_FRAME_BYTES`); no Pillow, the agent is stdlib-only. Frames are
  relayed to consoles and never stored. `vncPassword` (per-boot secret from
  `/tmp/labkiosk/vnc.secret`) and `remoteHost` (from `/etc/cloudflared/config.yml` or
  `LABKIOSK_REMOTE_HOST`) are sent only when present, so the hub keeps what it knew. There is no
  `currentUrl` and no CPU/RAM `metrics` — never build UI on fields that do not exist.
- `targetUrl` is validated by `safe_navigable_url()` before storing — it reaches `window.location`.
- **Broadcast state is in D1 in two places**: organization-wide (`tenants.broadcast_*`, set by
  target `"all"`) and per workstation (`client_devices.broadcast_*`, set by a list of ids). The hub
  serves **the newer**; a reset is stored as URL `NULL` **with** an epoch so it outranks older
  broadcasts. Epoch `0` = none. Storing only the `"all"` case made selected-screen broadcasts revert
  to the portal on the next heartbeat.

## 2. Commands (pushed over the socket, or in the heartbeat reply)

`ALLOWED_COMMANDS`: `lock`, `unlock`, `navigate`, `reload`, `reboot`, `shutdown`, `clear-session`,
`mute`. Anything else: `400` at the Worker, logged and ignored by the agent.

- No `broadcast` or `reset` action: a broadcast is `navigate` + epoch; Reset to Portal is
  `navigate` with `resetPortal: true`. `navigate` needs the `broadcast` permission, the rest
  `workstations`.
- `reload` advances `reloadEpoch` in `/api/status`; `content.js` reloads natively and remembers
  `lastReloadEpoch` in `sessionStorage`. **Never** `xdotool key F5` (absent in production).
- `clear-session` ends Chromium only; the launcher's watchdog deletes `/tmp/chromium-profile` and
  `/tmp/chromium-cache` before every relaunch (sign-ins, cookies, history, storage gone).
- `POST /api/command`: `targets[]` (or legacy `target`), deduped, `"all"` replaces named ids,
  ≤ 500 per request. The Worker hands them to the hub (`/enqueue`), which pushes them to connected
  workstations at once and keeps them 60 s for the rest; a command for `"all"` records a delivery
  per workstation, so each gets it once.

## 3. Enrolment — wizard → agent `POST /api/setup` → Worker `POST /api/devices/enroll`

- Payload `{ subdomain, clientId, enrollmentKey, customDomain }`; reply carries the device token,
  `organizationName` **and the deprecated alias `schoolName`** (agents from older ISOs read it).
  The agent reads either via `organization_name()`.
- The agent writes `/etc/labkiosk/config.json` (0600) with `workerUrl` and `targetUrl`. On an
  installed disk `/etc/labkiosk` is the `LABKIOSK_DATA` partition; on live media it is RAM, which is
  correct. `persistentStorage` / `persistent` report which.
- Worker URL: `https` only, except a local test server (loopback, container gateways, private IPv4
  `10/8`, `172.16/12`, `192.168/16`) — the same set as the Worker's `isDevHost()`.

## 4. Remote control

`x11vnc` on `127.0.0.1:5900` (per-boot password) → `websockify` on `127.0.0.1:6080` → Cloudflare
Tunnel to `<pc>.<tunnel_domain>`. No LAN listener. The console's noVNC frame gets `vncPassword` /
`remoteHost` from `GET /api/clients` (workstations permission).

## 5. Global rules both sides obey

Zero runtime npm deps in the Worker (Web Crypto only) · everything tenant-scoped and consensus
state in D1 or the organization's OrgHub, never isolate memory · fail closed on missing config · no placeholders or empty catches · LF line endings
(`.gitattributes`; never write with a newline-translating tool) · organization vocabulary
(organization / operator / staff / user / User Portal) · license statements match `LICENSE`.

## 6. When it does not work

| Symptom | Cause → fix |
|---|---|
| Workstation missing from the dashboard, agent logs `401` | Not enrolled, or its device token was revoked → re-run the wizard with the organization's current enrollment key (Settings → Security). |
| Freshly enrolled screen says "This page is blocked" | Chromium reads policy only at start → the agent sets `pendingBrowserRestart` and restarts it after the next policy sync. |
| Remote Control asks for a password or never connects | No heartbeat since boot (no `vncPassword` yet) or no tunnel → check `vncPassword`/`remoteHost` in `/api/clients`; provision a tunnel (`docs/REMOTE_CONTROL.md`). |
| Worker refuses to start (`SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set` / `The D1 database is missing the current schema`) | Secrets unset with a D1 binding, or migrations not applied → set secrets; `wrangler d1 migrations apply labkiosk-db --remote`. |
| Broadcast to some screens reverts to the portal | Worker older than migration `0010` → apply it and deploy together. |
| Worker refuses to start: `missing required bindings` | A platform resource was not created → `docs/DEPLOYMENT.md`, "Platform resources". |
| Agent log: `no WebSocket route … using the HTTP heartbeat` | Worker older than the OrgHub, or the Node development server `test/dev_server.ts` (no `WebSocketPair`; `pnpm dev` has one) → expected; it retries every 10 minutes. |
| An admin change reaches workstations only after minutes | The route saved it but never called `notifyConfigChanged()` → add the call; the hub's 5-minute config cache is only the safety net. |

## 7. Verify a full-stack change

```bash
pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-localization
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover -s distro-builder/tests -t distro-builder/tests
python3 distro-builder/tools/generate-chromium-policy.py --check
```

Then prove it where it runs: pages in a browser (`labkiosk-console-ui`), kiosk behaviour in the
simulator (`labkiosk-simulator`). A log line saying a command ran is not evidence it reached a screen.
On this Windows machine `python3` is the Store stub — use `python`.
