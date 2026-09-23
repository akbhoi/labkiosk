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
│   ├── migrations/                     # Cloudflare D1 SQL migrations (0001..0009)
│   ├── wrangler.jsonc                  # Routes, D1 binding, hourly cron trigger
│   ├── src/
│   │   ├── index.ts                    # Edge router, REST APIs, telemetry cache, scheduled()
│   │   ├── guard.ts                    # Tenant resolution + authorization + CSRF origin guard
│   │   ├── escape.ts                   # HTML / attribute / JSON escaping & safe URLs
│   │   ├── db.ts                       # D1 Database queries, SCHEMA_SQL & tenant seeding
│   │   ├── auth.ts                     # Native Web Crypto PBKDF2 authentication, CSP nonces
│   │   ├── d1_adapter.ts               # Node 22+ native `node:sqlite` mock for local unit tests
│   │   ├── ui.ts                       # School admin console: picks the page, fills the shell
│   │   ├── ui_admin_shared.ts          # Tenant API scope + Level 2 context panel behaviour
│   │   ├── ui_admin_*.ts               # One module per admin page: its markup, its context
│   │   │                               #   panel and its client script together
│   │   ├── ui_tokens.ts                # The one declaration of the design language: colours,
│   │   │                               #   radii and easing, plus the legacy aliases the public
│   │   │                               #   pages were written against
│   │   ├── ui_layout.ts                # Shared shell: 72px rail, 272px context panel, primitives
│   │   ├── ui_landing.ts               # Public SaaS Landing Page
│   │   ├── ui_school_home.ts           # The school homepage at the subdomain root (/)
│   │   ├── ui_portal.ts                # Student Learning Portal at /home (cards grid)
│   │   ├── ui_super.ts                 # Super Admin Master Console (/super)
│   │   ├── ui_legal.ts                 # Legal compliance pages (/privacy, /terms)
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

### 4. Workstation Groups & Batch Commands
- **Group Management:** Workstations can be organized into arbitrary named groups (e.g. "Row 1", "Lab A", "Physics"):
  - `GET /api/groups`: List workstation groups for the tenant.
  - `POST /api/groups`: Create a new group (`{ name }`).
  - `DELETE /api/groups/:id`: Delete group; sets member devices' `group_name` to `NULL`.
  - `POST /api/clients/group`: Assign devices to a group (`{ clientIds: string[], groupName: string }`).
- **Batch Command Dispatch (`POST /api/command`):**
  - Accepts `targets: string[]` (or legacy single `target: string`).
  - Allows targeting specific subsets of machines or selected workstations for commands (`lock`, `unlock`, `reboot`, `shutdown`, `reset`).
  - The teacher console features a "Select All" toggle, per-workstation and per-group selection checkboxes, dynamic selection count indicators, and targeted command buttons ("Lock", "Unlock", "Reboot", "Shutdown").

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
- Super admins are restricted from accessing any school's admin console, telemetry, or VNC remote desktop *except* for the dedicated `demo` school tenant to ensure school data privacy. Accessing school admin sub-routes (`/admin/workstations`, `/admin/apps-web`, etc.) as super admin routes directly to the `demo` school console (`?tenant=demo`) rather than bouncing to `/super`, and all internal console links preserve `?tenant=<subdomain>` when rendered outside the dedicated school subdomain. Full access permissions (`*`) are guaranteed for super admins on the `demo` tenant.
- School admins can delegate functions to sub-admins and teachers via `tenant_users` with granular permissions (`workstations`, `apps-web`, `teachers`, `settings`, with backward-compatible support for legacy `broadcast`, `portal`, `whitelist`).

### Rule 4b: Left-Side Multi-Level Panels Design & Seamless Transitions
- The dashboard control planes (both School Admin `/admin/*` and Super Admin `/super/*`) enforce a unified **Left-Side Multi-Level Panels Architecture**:
  - **Level 1 (Primary Rail — 72px)**: Slim, persistent vertical bar with brand glyph, exactly 4 primary module icons (Workstations, Apps & Web, Teachers & Staff, Lab Settings), live counter pills, bottom-left interactive profile avatar button with anchored popover menu (user details, role badge, password/settings shortcut, and POST sign-out), and panel collapse toggle.
  - **Level 2 (Secondary Action Panel — 272px)**: Context-aware sub-panel that expands seamlessly with hardware-accelerated CSS (`transform: translateX()`, `opacity`, `cubic-bezier(0.16, 1, 0.3, 1)`), providing module-specific tools, live filters, and batch commands. Subpanels strictly provide contextual tools and never duplicate the Level 1 Rail navigation (no redundant "Quick Navigation" or "Back to Workstations" lists).
  - **Workstations Module (`/admin/workstations`)**:
    - **Level 2 Subpanel**: Dedicated to Workstation Groups (`+ New Group`, live group member counts, group filtering, and group deletion). Removed redundant individual command buttons from sidebar.
    - **Top Toolbar**: Contains "Select All" toggle checkbox, dynamic selection count indicator (`# selected`), targeted classroom actions (`Lock`, `Unlock`, `Reboot`, `Shutdown`), `Move to Group...`, `Reset to Portal`, and `Broadcast URL`.
    - **Main Viewport**: Workstations are partitioned into collapsible `.group-section` containers with header chevrons and group selection checkboxes; collapse states persist in `localStorage`.
  - **Consolidated "Apps & Web" Module (`/admin/apps-web`)**:
    - Merges Lesson Broadcast, Student Portal Apps, and Domain Allowlist into a single, segmented module with 3 tab panes (`Lesson Broadcast`, `Student Portal Apps`, and `Domain Allowlist`), with deep linking via `?tab=...` and instant client-side tab switching (`history.replaceState`). Legacy routes (`/admin/broadcast`, `/admin/portal`, `/admin/whitelist`) 302-redirect to `/admin/apps-web?tab=<tab>`.
    - **Stabilized Sidebar Subpanel**: Fixed, non-shifting Level 2 subpanel featuring static tab view switchers (`📶 Lesson Broadcast`, `⊞ Student Portal`, `🛡️ Domain Allowlist`), a `Preview Student Portal &rarr;` shortcut opening `/home` in a new tab, and a static Module Overview card (total apps, allowed domains, live broadcast status). Eliminates dynamic layout shift.
    - **Cleaned Main Tabs**: Context formerly trapped in the subpanel was migrated directly into the relevant main tabs. Removed redundant "Standard Educational Presets" from Lesson Broadcast to prevent duplicate lists.
  - **Teachers & Staff Module (`/admin/teachers`)**:
    - **Level 2 Subpanel**: Interactive **"Role"** filter section (`All Roles`, `Teacher`, `Lab Assistant`, `Content Manager`, `Co-Administrator`, plus dynamic roles) with live count badges that filter the authorized instructors table instantly without page reload.
    - **Standard Accessible Checkboxes**: Uses styled `.form-checkbox` and `.form-checkbox-label` components with clean SVG checkmark tick mark, dark theme palette, hover highlights, and focus rings. Role dropdown preselects corresponding permission checkboxes automatically.
  - **Lab Settings Module (`/admin/settings`)**:
    - **Semantic Tab Panes**: Converted 9 fragile vertical scroll jumps into 4 distinct semantic tab panes (`General & Kiosk`, `Domains & Network`, `School Homepage`, `Security & Audit`) with instant client-side switching and deep linking (`?tab=...`).
    - **Horizontal Card Grouping (`grid-2col`)**: Organizes related configuration cards side-by-side (Institution Profile & Kiosk Mode \| Kiosk Routing & Home URL; Subdomain & VNC Tunnel \| Custom Domain; Homepage Identity \| Content Blocks; Enrollment Key & Admin Password \| Recent Lab Activity).
    - **Scrollable Activity Table (`.table-scrollable`)**: Recent Lab Activity table is constrained with `.table-scrollable` (`max-height: 480px; overflow-y: auto;`) with sticky pinned table headers (`th` with `position: sticky; top: 0; z-index: 2;`) and thin scrollbars, keeping the card compact and neatly aligned with the left column.
  - **Content Area & Clean Top Header**: Fluid layout adapting smoothly to panel states without content jumping. The top canvas header is kept clean and minimal, displaying solely breadcrumbs and telemetry counters; profile and sign-out controls strictly reside in the bottom-left avatar menu.
  - **Transitions & Micro-Interactions**: Hardware-accelerated CSS transitions, 2026 CSS tokens, dark glassmorphism surfaces (`backdrop-filter: blur(12px)`), accessible contrast (WCAG 2.2 AA), and zero inline event handlers (`data-action` pattern).

### Rule 4c: One Design Language, Declared Once
- `cloudflare-control/src/ui_tokens.ts` is the single declaration of the design
  language for every web surface: the two consoles, the public landing page, the
  student portal and the legal pages. Each renders its `:root` from
  `rootTokensCss()` and its fonts from `FONT_LINKS`; none opens a `:root` of its own.
- A class a page renders must be a class the shell declares, and the test suite
  fails otherwise (including `.table-scrollable`, `.form-checkbox`, `.form-checkbox-label`, `.grid-2col`, `.tab-pane`). See Rule 5c in
  [`cloudflare-control/AGENTS.md`](cloudflare-control/AGENTS.md).
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
