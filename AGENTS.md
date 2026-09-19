# AI Agent Codex & Master Architecture Playbook

> **Notice:** This repository was architected and co-developed through human-AI pair programming, initially with **Antigravity** (Google DeepMind) and later with Claude Code. Any AI agent (Antigravity, Claude, Copilot, Cursor, Codex, Gemini, etc.) working on this repository MUST strictly abide by the invariants, architectural patterns, and testing protocols defined across this codex.
>
> **Modular Subsystem Codices:**
> - 🐧 **Client Operating System & Distro Builder:** [`distro-builder/AGENTS.md`](distro-builder/AGENTS.md)
> - ☁️ **Cloudflare Workers SaaS Control Plane:** [`cloudflare-control/AGENTS.md`](cloudflare-control/AGENTS.md)
> - 🛠️ **Operating Skills & Procedures:** [`skills/labkiosk-core/SKILL.md`](skills/labkiosk-core/SKILL.md)

---

## 1. Master System Architecture Map

```text
labkiosk/
├── distro-builder/                     # Debian 12 Live-Build ISO & Hard Disk OS Pipeline
│   ├── config/bootloaders/             # ISOLINUX (BIOS) + GRUB EFI (UEFI) boot menus
│   ├── config/package-lists/           # Minimal OS packages (Openbox, Chromium, rsync, parted, efibootmgr)
│   ├── config/hooks/live/              # Lockdown & security hooks (users, polkit, Xorg, sysctl, GRUB pin)
│   ├── config/includes.chroot/         # Rootfs overlay injected into the live & installed image
│   │   ├── etc/chromium/policies/      # Managed enterprise policies (URLAllowlist, Blocklist)
│   │   ├── etc/openbox/rc.xml          # Window manager keybindings (stripped of escape keys)
│   │   ├── etc/overlayroot.conf        # RAM overlay (overlayroot="tmpfs", zero SSD wear)
│   │   ├── opt/labkiosk/
│   │   │   ├── setup/wizard.html       # Setup & Enrollment Wizard GUI (HTML/JS)
│   │   │   ├── extension/              # Manifest V3: content.js (top bar & curtain) + background.js
│   │   │   └── agent/agent.py          # Python 3 telemetry daemon & loopback API
│   │   └── usr/local/bin/
│   │       └── labkiosk-install        # Automated disk installer (GPT, ESP, ext4, dual GRUB)
│   ├── Dockerfile                      # Containerized cross-platform ISO builder
│   └── build-iso.sh                    # Native Debian/WSL2 build script
│
├── cloudflare-control/                 # Cloudflare Workers Control Plane (Edge SaaS)
│   ├── migrations/                     # Cloudflare D1 SQL migrations (0001..0005)
│   ├── wrangler.jsonc                  # Routes, D1 binding, hourly cron trigger
│   ├── src/
│   │   ├── index.ts                    # Edge router, REST APIs, telemetry cache, scheduled()
│   │   ├── guard.ts                    # Tenant resolution + authorization + CSRF origin guard
│   │   ├── escape.ts                   # HTML / attribute / JSON escaping & safe URLs
│   │   ├── db.ts                       # D1 Database queries, SCHEMA_SQL & tenant seeding
│   │   ├── auth.ts                     # Native Web Crypto PBKDF2 authentication, CSP nonces
│   │   ├── d1_adapter.ts               # Node 22+ native `node:sqlite` mock for local unit tests
│   │   ├── ui.ts                       # Teacher Lab Dashboard HTML/JS
│   │   ├── ui_landing.ts               # Public SaaS Landing Page
│   │   ├── ui_portal.ts                # Student Learning Portal (Educational Cards Grid)
│   │   ├── ui_super.ts                 # Super Admin Master Console (/super)
│   │   └── types.ts                    # Strict TypeScript interfaces
│   └── test/worker.test.ts             # Multi-tenant automated integration tests
│
├── Dockerfile                          # Workstation simulator image (ghcr.io/akbhoi/labkiosk)
├── docker-compose.yml                  # Runs the simulator; live-mounts the client source
├── docker-test/                        # Simulator entrypoint + docs (no Dockerfile: the
│                                       #   root one is the single simulator image)
├── docs/                               # Production deployment, remote control, and API specs
└── skills/                             # Automated AI skill definitions (labkiosk-core, distro, control)
```

---

## 2. Cross-Cutting Client-Server API Contracts

The Client Operating System and Cloudflare Control Plane communicate over authenticated HTTPS REST channels.

### 1. Workstation Heartbeat & Telemetry (`POST /api/telemetry`)
- **Caller:** `agent.py` on client workstation (every 3 seconds).
- **Authentication:** `Authorization: Bearer <device_token>`.
- **Payload** (exactly these keys; `post_telemetry()` in `agent.py` is the reference):
  - `clientNum`: Integer workstation number.
  - `activeUrl`: The URL the agent is currently pointing the kiosk at.
  - `isLocked`: Whether the lock curtain is currently up.
  - `thumbnail`: Base64 JPEG data URL from `scrot -t 20 -q 35`. **Omitted** when the encoded
    payload would exceed 256 KB (`MAX_THUMBNAIL_BYTES`), so an oversized frame is dropped rather
    than allowed to bloat a 3-second loop. No PIL/Pillow is involved: the agent is standard
    library only.
  - `vncPassword`: Per-boot ephemeral VNC secret from `/tmp/labkiosk/vnc.secret`. Sent only when
    present, so the control plane keeps what it already knows otherwise.
  - `remoteHost`: Cloudflare Tunnel hostname from `/etc/cloudflared/config.yml` or
    `LABKIOSK_REMOTE_HOST`. Sent only when present.
- **Not sent:** there is no `currentUrl` key and no `metrics` object. The agent collects no CPU,
  RAM or storage statistics; do not write a dashboard against fields that do not exist.
- **Response:**
  - `whitelist`: Approved domain list, merged into the Chromium managed policy.
  - `targetUrl`: Where the kiosk should point. Validated as `http(s)` by `safe_navigable_url()`
    before it is stored, because it ends up in `window.location`.
  - `commands`: Array of pending teacher commands. The agent implements `lock`, `unlock`,
    `navigate`, `reload`, `reboot`, `shutdown` and `mute`; anything else is logged and ignored.
    (There is no `broadcast` action — a broadcast is `navigate` plus `broadcastEpoch`.)
    Teacher `reload` commands advance the agent's internal `reloadEpoch` (returned in `GET /api/status`),
    which `content.js` detects in `syncLoop()` to trigger a native `window.location.reload()`, caching
    `lastReloadEpoch` in `sessionStorage` to prevent infinite reload loops. Synthetic X11 key injection
    (`xdotool key F5`) is strictly forbidden.
  - `broadcastUrl` / `broadcastEpoch`: Authoritative synchronized active lesson URL.

### 2. First-Boot Workstation Enrollment (`POST /api/setup`)
- **Caller:** Local setup wizard (`wizard.html`) via loopback agent `POST /api/setup`.
- **Target:** Control Plane `POST /api/devices/enroll`.
- **Payload:** `{ subdomain, clientId, enrollmentKey, customDomain }`.
- **Response:** A device bearer token, which the agent writes to **`/etc/labkiosk/config.json`**
  (mode 0600) together with the resolved `workerUrl` and `targetUrl`.
- **Where that file actually lives:** on live media it is in the RAM overlay and is gone at
  power-off, which is correct — the workstation is meant to be installed, not run from USB
  permanently. On an **installed** disk, `/etc/labkiosk` is a mount point for the `LABKIOSK_DATA`
  partition created by `labkiosk-install`, which is what makes a post-install enrolment persist;
  without it `overlayroot="tmpfs"` would discard the token on the next reboot.

### 3. Remote Control & Observation Channel
- **Loopback VNC:** `x11vnc` binds strictly to `127.0.0.1:5900` with an ephemeral per-boot password.
- **WebSocket Bridge:** `websockify` binds to `127.0.0.1:6080`.
- **Tunnel Egress:** Cloudflare Tunnel securely forwards loopback port 6080 to `<pc>.<TUNNEL_DOMAIN>` without exposing any listening port on the school's local LAN.
- **Teacher Dashboard:** Embedded noVNC frame authenticates via the device's current `vnc_password` retrieved securely through `GET /api/clients`.

---

## 3. Global Invariant Rules (Zero Exceptions)

### Rule 1: Zero NPM Dependencies in Cloudflare Worker
- The Cloudflare Worker control plane uses **0 runtime npm dependencies**.
- Hashing and session cryptography **must always use `crypto.subtle`** (Web Crypto API): `PBKDF2-HMAC-SHA256`, 100,000 iterations, 32-byte salt, 256 derived bits.
- Never introduce external routing libraries, auth frameworks, or heavy database ORMs. Keep worker cold starts under 10ms.

### Rule 2: 100% RAM Overlay Protection (`overlayroot="tmpfs"`)
- The client OS runs as an **immutable system with all disk writes diverted to RAM**:
  - Live ISO: `overlayroot="tmpfs"` (plus an optional `toram` boot entry, which is **not** the
    default and must be chosen from the menu).
  - Installed Drive: `overlayroot="tmpfs"` in `/etc/overlayroot.conf` on persistent ext4 partition.
- Flash storage on thin clients (e.g. 12 GB SSDs) is protected from write exhaustion. The underlying root filesystem remains mounted read-only (`ro`).
- Dynamic runtime files, browser profiles, logs, and downloads write to `/tmp` in `tmpfs` and reset completely upon reboot.

### Rule 3: Native Top-Level Navigation & Shadow DOM Extension
- **Never load external educational websites inside an `<iframe>`**. Modern sites enforce `X-Frame-Options: SAMEORIGIN` and fail.
- Chromium navigates top-level pages.
- The Chrome extension (`content.js`) injects the navigation header into the top frame inside an isolated **Shadow DOM**.
- The content script **never** communicates with the agent directly (which would require unsafe wildcard CORS). It communicates through `background.js` (MV3 service worker), which owns `host_permissions` for `http://127.0.0.1:8888/*`.
- The navigation bar **auto-hides** (`transform: translateY(-100%)`) and appears only when `mouseY <= 12px`. Viewport occupies 100% height with 0px scroll offset.
- **International Keyboard Input**: `content.js` intercepts unauthorized keystrokes in all frames but MUST explicitly allow `event.getModifierState("AltGraph")` for printable characters and allow `event.key === "Dead"` for dead keys. International keyboards rely on `AltGr` for symbols (e.g. `@`, `€`, `\`) and diacritics; blocking them breaks non-US layouts.
- **Query Parameter Preservation**: URL normalization in `content.js` must preserve `u.search` query parameters so educational applications with query parameters (e.g. `?room=101&user=demo`) are retained and not falsely identified as root broadcast URLs.
- **Dynamic Directionality (RTL/LTR)**: The extension applies `dir="rtl"` or `dir="ltr"` to the host container, top bar, curtain, and modal based on the active catalog's `_meta.direction`.

### Rule 4: Multi-Tenant Scoping & Security Guards
- Every database query in `db.ts` dealing with devices, commands, sessions, or portal apps **must filter by `tenant_id`**.
- Authoritative state (broadcasts, credentials, sessions) resides in D1, not isolate memory.
- Every endpoint is strictly guarded via `guard.ts`: `resolveTenant()`, `requireTenantAdmin()`, `requireSuperAdmin()`, `requireDevice()`, and `rejectCrossSiteMutation()`.

### Rule 5: Zero Placeholders
- ❌ No `// TODO: Implement later`
- ❌ No empty `catch (e) {}` blocks.
- ❌ No mock data stubs in production code.
- ❌ No unverified constants. Cryptographic checksums and pins (`cloudflared.pin`, `grub.pin`) fail closed if unverified.

### Rule 6: Fail Closed
- Missing configuration is an error, not a reason to fall back to an insecure default.
- The agent binds its local API exclusively to `127.0.0.1`.
- Production database requires schema migrations to be applied before serving requests.

### Rule 7b: The Simulator Container Is Untrusted Too
- The workstation simulator (root `Dockerfile`, `docker-compose.yml`) runs as the unprivileged `kiosk`
  user with Chromium's sandbox enabled, a read-only root filesystem, `cap_drop: ALL` apart from the
  `SYS_CHROOT` that sandbox needs, `no-new-privileges`, and its noVNC port published on `127.0.0.1`
  only. It browses the open web, so it is hardened like something that will be attacked.
- `--no-sandbox` survives only as the entrypoint's fallback for a container started as root, and it
  warns when it takes it. Never make it unconditional again.

### Rule 7: Network Subsystem & State Persistence Guarantee
- Network profiles (Ethernet and Wi-Fi) configured via the setup wizard or agent API are managed through NetworkManager.
- To survive `overlayroot="tmpfs"` reboots on installed hardware, connection keyfiles are stored on the persistent `LABKIOSK_DATA` partition in `/etc/labkiosk/system-connections/` (mode `0700`, files mode `0600`, root:root) and bind-mounted to `/etc/NetworkManager/system-connections` via `/etc/fstab`.
- The unprivileged `kiosk` user is granted Polkit privileges for NetworkManager via `/etc/polkit-1/rules.d/50-labkiosk-network.rules` to allow the agent to manage network connections without running the agent as root.
- Post-installation network changes and workstation reboots are gated behind administrator authentication (PBKDF2 verification against `/etc/grub.d/01_labkiosk_password`). The gate is enforced by the agent, not only the UI: `/api/admin/verify` issues a 10-minute token (throttled after 5 failures) and `/api/network/configure` as well as `POST /api/reboot` refuse an installed workstation's request without it (`X-LabKiosk-Admin`).
- The browser extension (`content.js`) monitors network connectivity via `/api/status`, displays live online/offline state in the kiosk top bar, and redirects to `/setup#offline` if the workstation is offline for more than 6 seconds on an external, unlocked page. That page returns to the lesson by itself once the connection is back.
- Wi-Fi scan results (SSIDs) are attacker-chosen and are rendered with `textContent` only: the wizard's origin can drive the disk installer.

---

## 4. Subsystem Quick Reference

| Subsystem | Key Files | Architecture Document |
| :--- | :--- | :--- |
| **Debian 12 Live Kiosk OS** | `distro-builder/auto/`, `distro-builder/Dockerfile` | [`distro-builder/AGENTS.md`](distro-builder/AGENTS.md) |
| **Automated Disk Installer** | `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install` | [`distro-builder/AGENTS.md`](distro-builder/AGENTS.md) |
| **Client Agent & API** | `distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py` | [`distro-builder/AGENTS.md`](distro-builder/AGENTS.md) |
| **Browser Extension (MV3)** | `distro-builder/config/includes.chroot/opt/labkiosk/extension/` | [`distro-builder/AGENTS.md`](distro-builder/AGENTS.md) |
| **Setup & Install Wizard** | `distro-builder/config/includes.chroot/opt/labkiosk/setup/wizard.html` | [`distro-builder/AGENTS.md`](distro-builder/AGENTS.md) |
| **Cloudflare Control Plane** | `cloudflare-control/src/index.ts`, `guard.ts`, `auth.ts` | [`cloudflare-control/AGENTS.md`](cloudflare-control/AGENTS.md) |
| **Database & Migrations** | `cloudflare-control/migrations/`, `cloudflare-control/src/db.ts` | [`cloudflare-control/AGENTS.md`](cloudflare-control/AGENTS.md) |
| **HTML UI & CSP Nonces** | `cloudflare-control/src/ui*.ts`, `cloudflare-control/src/escape.ts` | [`cloudflare-control/AGENTS.md`](cloudflare-control/AGENTS.md) |
| **Integration Test Suite** | `cloudflare-control/test/worker.test.ts` | [`cloudflare-control/AGENTS.md`](cloudflare-control/AGENTS.md) |

---

## 5. Verification Quick Reference

```bash
# 1. Cloudflare Worker Typecheck & Tests
pnpm --prefix cloudflare-control run typecheck
pnpm --prefix cloudflare-control test

# 2. Client Distro Syntax Check
# PYTHONPYCACHEPREFIX is not optional: without it py_compile writes __pycache__
# directories *inside* config/includes.chroot, and live-build copies whatever is
# on disk straight into the ISO -- shipping bytecode built for the wrong
# interpreter into the image.
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js

# The client's own validators: the loopback boundary, URL and catalog checks,
# the persistence test, the locale spellings and the keyboard lockdown.
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover \
  -s distro-builder/tests -t distro-builder/tests

# The boot-time Chromium policy is generated from the single policy base; this
# fails if the committed copy has drifted from it.
python3 distro-builder/tools/generate-chromium-policy.py --check

# 3. Build the ISO (run from the repository root)
docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder
docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" ghcr.io/akbhoi/labkiosk-iso-builder
```

The engine must be **rootful**: `debootstrap` creates device nodes with `mknod`, which a rootless
user namespace refuses even under `--privileged`. See
[`distro-builder/AGENTS.md`](distro-builder/AGENTS.md) for the one-time switch if `docker` is
served by a podman machine.
