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
