---
name: labkiosk-core
description: Master engineering, architecture, debugging and verification procedures for Lab Kiosk (Debian 12 kiosk image, Python agent, hard disk installer, MV3 extension, Cloudflare Workers + D1 control plane). Use when coordinating full-stack tasks, adding or changing worker routes, templates, database schema, client agent, installer scripts, ISO build hooks, Chromium policies, or diagnosing multi-tenant routing, CSP, enrolment, telemetry, or remote-control problems.
---

# Lab Kiosk Core Engineering Skill

This skill guides AI coding assistants through authoring, modifying, testing, and verifying both the **Debian 12 Client Operating System** and the **Cloudflare Workers Multi-Tenant SaaS Platform**.

> **Co-Development Notice:** This skill and the underlying platform were co-developed through human-AI pair programming (Antigravity by Google DeepMind, then Claude Code). The invariants it relies on are defined in [`AGENTS.md`](../../AGENTS.md).
>
> **Specialized Subsystem Skills:**
> - 🐧 **Client OS & Distro Builder:** [`skills/labkiosk-distro/SKILL.md`](../labkiosk-distro/SKILL.md) & [`distro-builder/AGENTS.md`](../../distro-builder/AGENTS.md)
> - ☁️ **Cloudflare Edge Control Plane:** [`skills/labkiosk-control/SKILL.md`](../labkiosk-control/SKILL.md) & [`cloudflare-control/AGENTS.md`](../../cloudflare-control/AGENTS.md)

---

## 1. Operating Procedures

### A. Modifying Cloudflare Worker Code
1. Inspect `cloudflare-control/src/types.ts` before editing API contracts.
2. **Before adding any route**, read `src/guard.ts` and `src/escape.ts`. Every route resolves its
   tenant through `resolveTenant()` and guards access with `requireTenantAdmin()`,
   `requireSuperAdmin()` or `requireDevice()`; every rendered value is escaped. There are no
   exceptions, and the test suite asserts both. Cookie-authenticated mutations already pass the
   CSRF origin check in `index.ts`; do not add routes outside `/api/` that mutate state.
3. **Before touching a `ui*.ts` template**: every `<script>` carries `nonce="${escapeAttr(nonce)}"`
   and there are no inline `on*=` handlers, only `data-action` attributes with a delegated
   listener (or `addEventListener`). The CSP test renders every page and fails otherwise.
4. State two requests must agree on goes in D1, never in a module-level variable: the active broadcast
   (`tenants.broadcast_url` / `broadcast_epoch`) and device remote-control credentials (`vnc_password` / `remote_host`).
5. If altering the database schema:
   - Add a **new** numbered migration under `cloudflare-control/migrations/` (never edit an applied one).
   - Mirror the table/index definition in `SCHEMA_SQL` inside `cloudflare-control/src/db.ts`, which is
     what the in-memory adapter builds from. The two must stay in agreement.
   - Ensure all queries filter by `tenant_id`.
6. Verify type-safety (checks worker and test projects separately):
   ```bash
   pnpm --prefix cloudflare-control run typecheck
   ```
7. Run integration tests, and add a negative test for any route you add:
   ```bash
   pnpm --prefix cloudflare-control test
   ```
8. To try it in a browser, `wrangler dev` needs local secrets and applies migrations first:
   ```bash
   cd cloudflare-control && cp .dev.vars.example .dev.vars && pnpm dev
   ```
9. **Environment Variables Management**: Never define production secrets or configuration in the `vars` block of `wrangler.jsonc`, as `wrangler deploy` overrides Cloudflare Dashboard settings. Configure production variables (`DEFAULT_DOMAIN`, `ISO_DOWNLOAD_URL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`) directly in the Cloudflare Dashboard / `wrangler secret`, and use `.dev.vars` for local development.

### B. Modifying Client Kiosk Agent, Installer & Extension
1. **Client Agent** lives at `distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py`.
   Its local API is loopback-only (`/setup`, `/api/status`, `/api/setup`, `/api/install/disks`, `/api/install`, `/api/install/status`, `/api/reboot`, `/api/network/status`, `/api/network/interfaces`, `/api/network/wifi/scan`, `/api/network/configure`, `/api/network/test`, `/api/admin/verify`, `/api/log`). Telemetry is authenticated with a device bearer token. Each heartbeat reports the per-boot VNC password and Cloudflare Tunnel hostname.
2. **Automated Disk Installer** lives at `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`.
   - Formats disk with Hybrid GPT (Partition 1: `bios_grub`, Partition 2: `ESP`, Partition 3: `ROOT`, Partition 4: `DATA` mounted at `/etc/labkiosk`).
   - Copies rootfs cleanly via `rsync` without `--delete`.
   - Mounts `part_esp` to `/boot/efi` **only after** `rsync` finishes (eliminates `EBUSY (16)` deadlocks).
   - Copies existing NetworkManager connection profiles to `/mnt/target_kiosk/etc/labkiosk/system-connections/` (mode 0600) and adds an `/etc/fstab` bind mount (`/etc/labkiosk/system-connections /etc/NetworkManager/system-connections none bind,nofail 0 0`) so network configuration survives `overlayroot="tmpfs"` reboots.
   - Installs dual bootloaders (UEFI `x86_64-efi --removable` and BIOS `i386-pc`).
   - All logging writes to `file=sys.stderr`; `sys.stdout` is reserved exclusively for JSON.
3. **Session Awareness & Wizard Workflow (`wizard.html`):**
   - Both `agent.py` and `labkiosk-install` detect whether the system is booted from live media (`boot=live` in `/proc/cmdline`, `/run/live`) or installed disk (`/etc/labkiosk-installed`).
   - Live wizard features a sequential 2-step stepper: `Step 1: Network Setup` (Ethernet/Wi-Fi, DHCP/Custom DNS/Static IP, Proxy) followed by `Step 2: Destination Mode` (Install to Disk vs. Live Preview & Enroll).
   - On an installed workstation the wizard opens **on the enrolment form**: the network step is not shown again after installation. Network settings are reached at `/setup#network` from the top-bar network icon or the offline auto-fallback, protected by the administrator boot password, which the agent enforces with a short-lived token. The form is pre-filled from the saved profile (`profile` in `/api/network/status`).
4. **Browser Extension (MV3)** lives at `distro-builder/config/includes.chroot/opt/labkiosk/extension/`.
   `content.js` builds the nav bar, `#btn-network` status indicator, admin verification modal, and lock curtain inside an isolated Shadow DOM; `background.js` (service worker with `host_permissions`) is the exclusive bridge to the agent and owns the once-per-session flag that reveals the auto-hiding bar briefly at the start of each boot. Redirects to `/setup#offline` if offline for more than 6 s on an external, unlocked page.
5. **Syntax-check** before packaging or testing:
   ```bash
   PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
   PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
   node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
   node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
   ```
6. **Build ISO Image (Docker)** — from the repository root:
   ```bash
   docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder
   docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" ghcr.io/akbhoi/labkiosk-iso-builder
   ```
   The engine must be **rootful**. `debootstrap` creates device nodes with `mknod`, which a
   rootless user namespace refuses even under `--privileged`, so the build dies in the chroot
   stage. If `docker` is served by a podman machine, switch it once with
   `podman machine stop && podman machine set --rootful && podman machine start`.

### C. Capturing Visual Screen Verification
Never claim a UI change is complete without inspecting a visual capture. The agent logging a command
as executed proves only that the agent ran; it does not prove the student saw anything:
```bash
# Capture display 0 inside the container
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png
docker cp labkiosk-client-01:/tmp/verify.png .
```

---

## 2. Critical Edge Cases & Troubleshooting

### 1. `X-Frame-Options` and `Content-Security-Policy` Blocks
- **Symptom:** Webpage displays "www.khanacademy.org refused to connect" or blank white frame.
- **Root Cause:** Loading modern web applications inside `<iframe>` tags is blocked by modern security headers.
- **Remedy:** Always load educational applications in top-level native browser frames. Rely on the injected Chrome extension (`content.js`) for the top navigation bar and fullscreen lock curtain.

### 2. `rsync: rmdir(boot/efi) failed: Device or resource busy (16)`
- **Root Cause:** Submount `/boot/efi` was mounted before `rsync --delete` ran.
- **Remedy:** Mount only the root partition during `rsync`; never pass `--delete` into a freshly formatted filesystem; mount the EFI partition to `/boot/efi` only after `rsync` finishes.

### 3. Chromium Policy Syntax Rules
- **Invalid Pattern:** `http://localhost:*` or `127.0.0.1:*` (Chromium will discard the rule with an `Invalid pattern` error).
- **Valid Pattern:** `localhost` or `127.0.0.1` or `host.containers.internal`. Omission of port matches all ports automatically.

### 4. Miniflare / D1 Multiline SQL Parsing on Windows
- **Symptom:** `D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS ... incomplete input`.
- **Root Cause:** Miniflare's `db.exec()` breaks when parsing multiline strings with Windows CRLF line endings.
- **Remedy:** Always split statements by `;`, normalize newlines with `.replace(/\r\n/g, "\n")`, and execute statements sequentially using `db.prepare(stmt).run()`.

### 5. Chromium Root Execution in Docker
- **Symptom:** `Running as root without --no-sandbox is not supported`, or
  `Check failed: sys_chroot("/proc/self/fdinfo/")` with a black screen.
- **Cause:** the container was started as root, or without the `SYS_CHROOT` capability that
  Chromium's sandbox needs to chroot its zygote.
- **Remedy:** run the simulator as its unprivileged `kiosk` user with the `cap_add: SYS_CHROOT`
  from `docker-compose.yml`, so the sandbox stays on exactly as it is on the real image. The
  entrypoint falls back to `--no-sandbox` only when it is running as uid 0, and warns. Neither
  image may ever be launched with `--disable-web-security`.

### 6. Schema Drift Between the Adapter and Migrations
- **Symptom:** `Columns of "x" differ between SCHEMA_SQL and migrations/`.
- **Cause:** A schema change landed in only one of the two places that declare it.
- **Remedy:** Add a new numbered file under `migrations/` **and** make the matching edit to
  `SCHEMA_SQL` in `src/db.ts`. Never edit an already-applied migration.

### 7. Build Pins Are Not Optional Defaults
- `cloudflared.pin` and `grub.pin` under `config/includes.chroot/usr/share/labkiosk/` hold values that
  cannot be verified from the repository: a release checksum and a boot-password hash.
- An unset checksum builds without the tunnel binary; a bad one **fails the build**. An unset GRUB
  password builds with a loud warning. Never invent a value to make a build go green.
- `novnc.pin` pins the noVNC web client for both the ISO and the simulator. It is mandatory: an
  empty or wrong checksum fails both builds. Compute a new one from the release tarball, never
  copy it from elsewhere.

### 8. Chromium Refuses the Kiosk's Own Extension
- **Symptom:** No navigation bar, no lock curtain. Chromium logs *"Loading of unpacked extensions is
  disabled by the administrator"*.
- **Cause:** A blanket extension block in the managed policy (`ExtensionInstallBlocklist: ["*"]`).
- **Remedy:** Do not add a blanket block. Students cannot install extensions anyway (`chrome://` blocked, kiosk mode, no Web Store in allowlist, profile wiped on launch).

### 9. Freshly Enrolled Workstation Shows "This page is blocked"
- **Symptom:** Enrolment succeeds, the dashboard shows the workstation, but its screen is a Chromium block page.
- **Cause:** Chromium reads its managed policy at startup.
- **Remedy:** The agent sets `pendingBrowserRestart` at enrolment and restarts the browser after the next policy sync.

### 10. Workstation Not Appearing on the Dashboard
- **Symptom:** The agent logs `401` responses, or the grid stays empty after boot.
- **Cause:** The workstation is not enrolled, or its device token was revoked.
- **Remedy:** Re-run the setup wizard with the school's current enrollment key (**Settings -> Workstation Enrollment Key** on the teacher dashboard).

### 11. A Console Button Does Nothing, Console Shows a CSP Error
- **Symptom:** "Refused to execute inline event handler" or "Refused to execute inline script".
- **Cause:** A template gained an `on*=` attribute, or a `<script>` without the response nonce.
- **Remedy:** `data-action` + delegated listener, and `nonce="${escapeAttr(nonce)}"` on the script.

### 12. Worker Refuses to Start
- **`SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set`:** there is no default super admin once a D1 binding exists.
- **`The D1 database is missing the current schema`:** run `wrangler d1 migrations apply labkiosk-db --remote` (or `--local`).

### 13. "Remote Control" Cannot Connect
- **Symptom:** The noVNC frame asks for a password, or never connects.
- **Cause:** The workstation has not sent a heartbeat since boot (no `vncPassword` yet), or it has no Cloudflare Tunnel.
- **Remedy:** Check `/api/clients` for `vncPassword` and `remoteHost`. Provision a per-workstation tunnel (`docs/REMOTE_CONTROL.md`).
