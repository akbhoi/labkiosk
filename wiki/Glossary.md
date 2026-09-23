# Glossary

---

### Agent

`agent.py`, the Python 3 daemon on each workstation. Serves the loopback setup API, runs the three-second telemetry heartbeat, syncs the Chromium policy, and executes teacher commands. Started from the Openbox autostart under a supervisor loop, not as a systemd service — it needs the kiosk user's X session. → [Client Agent](Client-Agent)

### Allowlist

The set of domains a workstation's Chromium may load. Chromium blocks everything by default (`URLBlocklist` deny-all) and `URLAllowlist` re-permits. The **effective** allowlist is the school's permanent list unioned with every portal app's host and the active broadcast's host, computed per heartbeat by `buildEffectiveWhitelist()`.

### Broadcast

A lesson URL pushed to a whole lab at once, persisted on the tenant row so it survives reboots and colo differences. Not its own command action: it is `navigate` to `target: "all"` plus a `broadcastEpoch`. → [Teacher Dashboard Guide](Teacher-Dashboard-Guide#broadcast--push-a-lesson-to-the-whole-lab)

### Broadcast epoch

A monotonic marker (`tenants.broadcast_epoch`) that lets a workstation tell a *new* broadcast from one it already obeyed, so it navigates exactly once rather than every three seconds. `0` means no broadcast is active.

### Client ID

A workstation's human-readable identifier — `PC-01`, `LAB3-07`. Matches `^[A-Z0-9][A-Z0-9_-]{0,62}$`. Chosen at enrolment; changing it means decommissioning and re-enrolling.

### Command delivery receipt

A row in `command_deliveries` (`command_id`, `client_id`) recording that a workstation has received a command, so a broadcast executes exactly once per machine.

### Control plane

The Cloudflare Worker and its D1 database. One deployment serves every school. → [Control Plane Internals](Control-Plane-Internals)

### Curtain

See **Lock curtain**.

### D1

Cloudflare's SQLite-at-the-edge database. Lab Kiosk's only durable store.

### Device token

A 32-byte random hex bearer token issued to a workstation at enrolment. Only its SHA-256 is stored. It — never the request body — determines a workstation's identity and tenant on `/api/telemetry`.

### Enrollment key

A per-school shared secret a new workstation exchanges once for its own device token. **Empty by default**, and an empty key authenticates nothing. Rotating it does not affect already-enrolled workstations.

### ESP

EFI System Partition. Partition 2 of the installed layout (2 MiB – 514 MiB, FAT32), holding the UEFI bootloader. Mounted at `/boot/efi` **only after** `rsync` completes.

### Fail closed

Missing configuration is an error, not a reason to fall back to something weaker. Unapplied migrations, absent super-admin secrets, and unverified build pins all refuse to proceed.

### Guard

A function in `src/guard.ts` enforcing authorization before a handler runs: `resolveTenant()`, `requireTenantAdmin()`, `requireSuperAdmin()`, `requireDevice()`, `rejectCrossSiteMutation()`. A route without one is a security defect.

### Hybrid GPT

The installer's four-partition layout — `bios_grub`, `ESP`, `ROOT`, `DATA` — that boots on both legacy BIOS and UEFI machines. → [Disk Installer](Disk-Installer#partition-layout)

### `is_live_session()`

The check, implemented identically in the agent and the installer, deciding whether the machine booted from removable media (`/run/live`, `boot=live`) or from an installed disk (`/etc/labkiosk-installed`).

### Kiosk user

The unprivileged Linux account the whole session runs as. Has an **empty** password rather than a locked one — a locked account deadlocked nodm's PAM stack — and exactly one sudo grant, `NOPASSWD` on the installer.

### `LABKIOSK_DATA`

The 512 MiB ext4 partition at the end of an installed disk, mounted at `/etc/labkiosk`. The only persistent write target on an installed workstation, existing so a post-install enrolment survives a reboot.

### `LABKIOSK_ROOT`

The ext4 partition holding the Debian system, mounted read-only under the RAM overlay.

### Live-build

Debian's ISO construction toolchain. Driven by `auto/config`, `auto/build`, and `auto/clean` under `distro-builder/`.

### Lock curtain

A full-screen overlay the extension raises on every tab when a teacher sends `lock`. Swallows mouse, keyboard, and touch events in the capture phase. A DOM-level block, not an X11 input grab. → [Browser Extension](Browser-Extension#the-lock-curtain)

### Loopback API

The agent's HTTP server on `127.0.0.1:8888`. Requires a loopback `Host` **and** a loopback `Origin` — or the kiosk extension's own pinned `chrome-extension://` origin, which Chromium puts on the service worker's `POST` to `/api/admin/verify`; either check failing returns `403`.

### Manifest V3 / MV3

Chromium's current extension platform. Lab Kiosk's extension uses a service worker (`background.js`) rather than a persistent background page.

### Mode

`portal` (the app-launcher grid) or `single_url` (one destination, no launcher). Stored on the tenant row and delivered in every telemetry response.

### nodm

The minimal auto-login display manager that starts the X session as `kiosk`. Configured through `/etc/default/nodm` rather than a systemd unit in the overlay.

### Nonce

A random per-response value stamped on every `<script>` and named in the Content-Security-Policy header. A script without it does not execute.

### noVNC

The HTML5 VNC client `websockify` serves, embedded in the teacher dashboard for remote control.

### Openbox

The window manager, running with a deliberately **empty** keybinding table so Alt+Tab, Alt+F4, and Ctrl+Alt+Del are inert.

### `overlayroot`

The Debian package providing the read-only root with a RAM overlay. Configured as `overlayroot="tmpfs"` on live media and installed disks alike. The project's core guarantee.

### PBKDF2

The password hashing function, run through `crypto.subtle`: HMAC-SHA256, 100 000 iterations, 32-byte random salt, 256 derived bits.

### Portal site / portal card

An application card on the Student Learning Portal. Adding one implicitly authorises its domain. → [Student Portal](Student-Portal)

### Reserved slug

A subdomain the platform keeps for itself: `www`, `super`, `labkiosk`, `api`, `admin`, `portal`, `status`, `mail`, `app`, `kiosk`, `root`. Neither registerable nor resolvable as a school.

### Shadow DOM

The isolated DOM subtree the extension's UI lives in, attached with `{ mode: "closed" }` so page script cannot reach it.

### `single_url` mode

Total lockdown to one destination, with no launcher. See **Mode**.

### Simulator

The Docker container that behaves like an enrolled thin client, viewable through noVNC. Defined by the **repository-root** `Dockerfile`. → [Workstation Simulator](Workstation-Simulator)

### Super admin

The platform operator, distinct from a school's teacher admin. Approves and suspends schools, and binds custom domains. → [Super Admin Guide](Super-Admin-Guide)

### Telemetry

The three-second heartbeat carrying the whole client–server relationship: state and a thumbnail up, commands, allowlist, mode, target, and broadcast down.

### Tenant

One school. Every query touching devices, commands, sessions, or portal apps filters by `tenant_id`.

### Thumbnail

A base64 JPEG captured with `scrot -t 20 -q 35` and sent in the heartbeat. Dropped — not shrunk — when it would exceed 256 KB.

### `toram`

An **opt-in** boot menu entry copying the whole image into RAM before starting, so the USB stick can be removed. Not what the default entry does.

### Tunnel

A Cloudflare Tunnel giving a workstation's loopback noVNC gateway a public hostname without any inbound port on the school network. Optional; only interactive remote control needs one.

### websockify

Bridges the WebSocket the browser speaks to the raw VNC port x11vnc listens on. Binds `127.0.0.1:6080` on the real image.

### Wizard

`wizard.html`, the first-boot setup and installation UI served by the agent at `http://127.0.0.1:8888/setup`. Returns `403` once the workstation is enrolled.

### x11vnc

The VNC server exporting display `:0`, bound to loopback with a per-boot ephemeral password and run with `-noclipboard -nocmd`.

→ [Home](Home) · [Architecture Overview](Architecture-Overview)
