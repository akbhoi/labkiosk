# AI Agent Codex & Architecture Playbook

> **Notice:** This repository was architected and co-developed through human-AI pair programming with **Antigravity** (Google DeepMind's Advanced Autonomous AI Coding System). Any AI agent (Antigravity, Claude, Copilot, Cursor, ChatGPT, etc.) working on this repository MUST strictly abide by the invariants, architectural patterns, and testing protocols defined in this document.

---

## 1. System Architecture Map

```text
labkiosk/
├── distro-builder/                     # Debian 12 Live-Build ISO Pipeline
│   ├── config/includes.chroot/         # Rootfs overlay directly injected into the OS image
│   │   ├── etc/chromium/policies/      # Dynamic enterprise policies (URLAllowlist, Blocklist)
│   │   ├── etc/openbox/rc.xml          # Window manager keybindings (Stripped of escape keys)
│   │   ├── etc/overlayroot.conf        # RAM overlay (All disk writes diverted to tmpfs in RAM)
│   │   ├── opt/labkiosk/
│   │   │   ├── setup/                  # First-boot enrolment wizard GUI (HTML/JS)
│   │   │   ├── extension/              # Manifest V3: content.js (top bar & curtain) +
│   │   │   │                           #   background.js (service worker; sole agent caller)
│   │   │   └── agent/agent.py          # Python 3 background daemon (telemetry & command executor)
│   │   └── usr/share/labkiosk/         # Build pins: cloudflared.pin (checksum), grub.pin (boot password)
│   ├── config/hooks/live/              # 01-lockdown (users, polkit, Xorg), 02-security (sysctl, GRUB)
│   ├── Dockerfile                      # Cross-platform containerized ISO builder
│   └── build-iso.sh                    # Native Debian/WSL2 build script
│
├── cloudflare-control/                 # Cloudflare Workers Control Plane (Edge SaaS)
│   ├── migrations/                     # Cloudflare D1 SQL migrations
│   ├── src/
│   │   ├── index.ts                    # Edge router, REST APIs, and telemetry cache
│   │   ├── guard.ts                    # Tenant resolution + authorization guards (MANDATORY)
│   │   ├── escape.ts                   # HTML / attribute / JSON escaping (MANDATORY)
│   │   ├── db.ts                       # D1 Database queries & tenant seeding
│   │   ├── auth.ts                     # Native Web Crypto PBKDF2 authentication
│   │   ├── d1_adapter.ts               # Node 22+ native `node:sqlite` mock for local unit tests
│   │   ├── ui.ts                       # Teacher Lab Dashboard HTML/JS
│   │   ├── ui_landing.ts               # Public SaaS Landing Page
│   │   ├── ui_portal.ts                # Student Learning Portal (Educational Cards Grid)
│   │   ├── ui_super.ts                 # Super Admin Master Console (/super)
│   │   └── types.ts                    # Strict TypeScript interfaces
│   └── test/worker.test.ts             # Multi-tenant automated unit tests
```

---

## 2. Invariant Rules for AI Agents (Do Not Violate)

### Rule 1: Zero NPM Dependencies in Cloudflare Worker
- The Cloudflare Worker control plane uses **0 runtime npm dependencies**.
- Hashing and session cryptography **must always use `crypto.subtle`** (Web Crypto API):
  - Algorithm: `PBKDF2-HMAC-SHA256`
  - Salt: 32 cryptographically random bytes (`crypto.getRandomValues`)
  - Iterations: 100,000
  - Key derivation: `deriveBits` producing 256 bits, encoded in hexadecimal.
- Never add external routing libraries, auth frameworks, or heavy database ORMs. Keep cold start under 10ms.

### Rule 2: 100% RAM Overlay Protection (`toram` + `overlayroot="tmpfs"`)
- The client runs as a **live image copied into RAM**; thin-client SSDs (as small as 12 GB, with limited write cycles) are never written to.
- The root filesystem **must remain mounted read-only (`ro`)**.
- Never configure persistent disk logging in `/var/log` or on rootfs. All runtime state, caches, VNC secrets and agent logs write to `/tmp`, which resides in RAM. `openbox/autostart` logging the agent to `/var/log/lab-agent.log` was a violation of this rule and is fixed.

### Rule 3: Native Top-Level Navigation & Auto-Hiding Viewport
- **Never load external educational websites inside an `<iframe>`**. Platforms like Khan Academy and YouTube enforce `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` and will fail with `ERR_BLOCKED_BY_RESPONSE`.
- Chromium must load URLs as top-level native pages.
- The Chrome extension (`content.js`) injects the navigation header into the top frame, inside a
  shadow root so a hostile page cannot restyle or query it.
- **The content script never calls the agent directly.** It posts `labkiosk:status` / `labkiosk:nav`
  messages to `background.js`, the MV3 service worker, which owns the `host_permissions` grant for
  `http://127.0.0.1:8888/*`. A content script's `fetch` runs in the page's origin and would require
  the agent to send `Access-Control-Allow-Origin: *` to every site on the internet. Do not move the
  fetch back into the content script, and do not reintroduce wildcard CORS in the agent.
- The top navigation bar **must auto-hide** (`transform: translateY(-100%)`) and appear only when `mouseY <= 12px`.
- Never modify `document.body.style.marginTop`; the webpage must occupy 100% of the viewport with zero vertical scroll overflow.

### Rule 4: Multi-Tenant Scoping & Data Isolation
- Every database query in `db.ts` dealing with devices, commands, sessions, or portal apps **must filter by `tenant_id`**.
- The in-memory telemetry cache is partitioned by tenant ID: `tenantTelemetryCache[tenantKey]`. It is a cache only; `client_devices` in D1 is the source of truth, because worker isolates are per-colo and short-lived.
- **Never resolve a tenant by hand.** Call `resolveTenant()` in `guard.ts`. The `Host` header is authoritative; `?tenant=` / `X-Tenant` are honoured only on a local dev host, for a super admin, for a session that already owns that tenant, or on an explicitly public route.
- **Never write a route without a guard.** Every endpoint that reads or changes a school's data calls `requireTenantAdmin()`; platform endpoints call `requireSuperAdmin()`; `/api/telemetry` calls `requireDevice()`. A route with no guard is a bug, not a convenience.
- A workstation's identity comes from its device token, never from the request body. `/api/telemetry` must ignore any `clientId` or tenant the payload claims.

### Rule 4b: Escape Everything Rendered
- Tenant data is attacker-controlled: school names, admin emails, portal card titles and URLs all arrive through public registration or the teacher console.
- Server-side, every interpolation into a `ui*.ts` template goes through `escapeHtml()` / `escapeJson()` from `escape.ts`. `escapeJson()` is required for anything inlined into a `<script>` block.
- Client-side, build DOM nodes and assign `textContent`. Never concatenate a value into `innerHTML`, and never place one inside an inline `onclick=` attribute — attach listeners and pass ids through `dataset`.
- URLs that will be navigated to, redirected to, or rendered as `href` must pass `safeHttpUrl()` first.

### Rule 5: Dynamic Client Collections (No Fixed PC Limits)
- Never hardcode fixed workstation counts (e.g. 40 PCs).
- Workstation cards must be dynamically rendered upon receiving their first heartbeat from `/api/telemetry`.
- Decommissioning a workstation via `/api/clients/remove` must purge it from both the memory cache and D1.

### Rule 6: Zero Placeholders
- ❌ No `// TODO: Implement later`
- ❌ No empty `catch (e) {}` blocks. Either handle the failure or log it with enough context to diagnose — a swallowed error in the policy writer silently freezes a school's allowlist.
- ❌ No mock data stubs in production paths. Write fully verified code.
- ❌ No invented constants. A checksum, release URL or credential you cannot verify does not get a plausible-looking placeholder value; make it a required input that fails loudly when unset (see `cloudflared.pin`).

### Rule 6b: The Schema Has Two Homes
- `migrations/` is what a deployed D1 has; `SCHEMA_SQL` in `db.ts` builds the in-memory database the tests and `wrangler dev` use. Both must be changed together.
- Add a **new** numbered migration; never edit one that has been applied.
- `test/worker.test.ts` compares the two and fails on drift, because a drifted adapter makes the whole suite test a shape production does not have.

### Rule 7: Fail Closed
- Missing configuration is an error, not a reason to fall back to something weaker. `getDatabase()` throws without a D1 binding unless `ALLOW_LOCAL_DB=1`; the ISO build refuses to ship an unpinned binary; the agent refuses to talk to anybody until it is enrolled.
- The client agent's local API binds to `127.0.0.1` only, and `websockify` binds to loopback on the real image. Publishing either on `0.0.0.0` hands every device on the school network control of the workstation.
- Chromium is never launched with `--disable-web-security`. `--no-sandbox` is permitted **only** in the Docker simulator, where the browser runs as root.
- Build inputs that cannot be verified from the repository are **pins**, not defaults: `cloudflared.pin` fails the build on a checksum mismatch, and `grub.pin` warns loudly when no boot password is set. Never substitute a plausible-looking value for one you cannot verify.

---

## 3. Verification & Testing Playbook

Whenever modifying code, run these commands in order:

### 1. TypeScript Strict Typecheck
```powershell
cmd /c rtk pnpm --prefix "cloudflare-control" run typecheck
```
*Expected result:* Exit code 0, zero errors. This checks two projects: `src/` against the Workers
runtime alone (so worker code cannot start depending on Node globals) and `test/` with `@types/node`.

### 2. Automated Multi-Tenant & Security Tests
```powershell
cmd /c rtk pnpm --prefix "cloudflare-control" test
```
*Expected result:* all tests passing (they use the Node 22 native `node:sqlite` D1 adapter in `d1_adapter.ts`, enabled by `ALLOW_LOCAL_DB: "1"` in the test env).

The suite deliberately includes negative tests — anonymous access, cross-tenant access, forged device
tokens, hostile school names and app titles, and duplicate broadcast delivery. **When you add a
route, add its negative test**; a green suite that only exercises the happy path is what let the
entire control plane ship with no authorization at all.

### 3. Docker Kiosk Verification
If the Docker test container (`labkiosk-client-01`) is running:
```powershell
# Copy a modified agent into the running container, then restart it:
cmd /c rtk docker cp distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py labkiosk-client-01:/opt/labkiosk/agent/agent.py
cmd /c rtk docker exec labkiosk-client-01 pkill -f agent.py

# Copy a modified extension. An MV3 extension is read at browser start, so the
# browser must be restarted -- copying the files alone changes nothing on screen.
cmd /c rtk docker cp distro-builder/config/includes.chroot/opt/labkiosk/extension labkiosk-client-01:/opt/labkiosk/
cmd /c rtk docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile

# Inspect agent logs:
cmd /c rtk docker exec labkiosk-client-01 tail -n 25 /tmp/lab-agent.log

# Capture a display screenshot to verify UI:
cmd /c rtk docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/screen.png
```

The watchdog loops in `openbox/autostart` and `docker-test/entrypoint.sh` relaunch Chromium within a
second and re-read the agent's `targetUrl` each time, so killing the browser is the supported way to
pick up a new extension or a freshly written policy.

**Verify on screen, not in the log.** A command the agent logs as executed is not a command the
student saw: the lock curtain was once absent for an entire debugging session while the agent
cheerfully logged every lock. Take a screenshot.

---

## 4. Known Pitfalls & Solutions

| Issue | Root Cause | Solution |
| :--- | :--- | :--- |
| **`D1_EXEC_ERROR: incomplete input`** | Miniflare/workerd parses multiline SQL in `db.exec()` poorly on Windows CRLF. | Split SQL by `;`, normalize newlines (`replace(/\r\n/g, "\n")`), and execute each statement via `db.prepare(stmt).run()`. |
| **Chromium `Invalid pattern http://127.0.0.1:*`** | Chromium managed policy `URLAllowlist` rejects port wildcards (`:*`). | Use hostname patterns without ports (e.g. `127.0.0.1`, `localhost`, `host.containers.internal`). Chromium matches all ports automatically. |
| **`Running as root without --no-sandbox is not supported`** | Inside Docker, Chromium runs as root. | Pass `--no-sandbox` **only** in `docker-test/entrypoint.sh`. The real image keeps the sandbox; `chromium-sandbox` is in the package list for exactly that reason. |
| **A teacher's "Portal Apps" or "Settings" button does nothing** | Unbalanced `<div>` tags in `ui.ts` nest those modals inside a hidden overlay. | The test suite asserts balanced tags and top-level modals; run it after any edit to `ui.ts` markup. |
| **A school's allowlist stops updating on the clients** | The agent could not write `/etc/chromium/policies/managed/policies.json`. | The directory must be owned by `kiosk` (see `01-lockdown.hook.chroot`). The agent logs `FAILED updating Chromium policy` when this happens — check `/tmp/lab-agent.log`. |
| **A workstation logs repeated `401`s and never appears** | It is not enrolled, or a teacher decommissioned it, which revokes its device token. | Re-run the setup wizard with the school's current enrollment key (**Settings → Workstation Enrollment Key**). |
| **`No D1 database bound` on startup** | `getDatabase()` fails closed rather than silently using an in-memory database that disappears with the isolate. | Bind `DB` in `wrangler.jsonc`, or set `ALLOW_LOCAL_DB=1` for local development and tests only. |
| **`Columns of "x" differ between SCHEMA_SQL and migrations/`** | The two copies of the schema drifted. | Apply the change to both: a new file in `migrations/` and the matching edit to `SCHEMA_SQL` in `db.ts`. |
| **Kiosk nav bar and lock curtain vanish** | A blanket extension block. `ExtensionInstallBlocklist: ["*"]` (or `ExtensionSettings` blocking `*`) makes Chromium refuse `--load-extension` entirely: *"Loading of unpacked extensions is disabled by the administrator"*. An `ExtensionInstallAllowlist` entry does **not** override it. | Do not add a blanket extension block. Students cannot install extensions anyway (`chrome://` blocked, kiosk mode, no Web Store in `URLAllowlist`, profile wiped each launch). To have both, pack the extension as a `.crx` and force-install it by id. |
| **Freshly enrolled kiosk shows "This page is blocked"** | Chromium reads its managed policy at startup, so a workstation that just enrolled is still running under the boot-time allowlist. | The agent sets `pendingBrowserRestart` at enrolment and restarts the browser after the next policy sync; the watchdog re-reads the agent's target URL on every relaunch. Keep `BROWSER_PROFILE_DIR` in `agent.py` matching `--user-data-dir` in the launchers, or the `pkill` matches nothing. |
| **Lock curtain never appears although the agent logs the lock** | `initKioskUi()` returned `undefined` when the UI already existed, so a second call overwrote `shadowRoot` and the sync loop skipped its whole update block. The bar still rendered and its dot kept its default green, which looks healthy. | `initKioskUi()` now returns the existing `shadowRoot`, and callers never assign a falsy result over a good one. A green dot is not evidence of a successful poll -- check `/tmp/lab-agent.log` and the agent's `/api/status`. |
| **Content script cannot reach the agent** | A content script runs in the page's origin, so `fetch("http://127.0.0.1:8888/...")` is cross-origin and needs the agent to send `Access-Control-Allow-Origin: *` to every site. | The fetch lives in the extension's service worker (`background.js`), which is governed by `host_permissions` rather than page CORS. The content script asks it via `chrome.runtime.sendMessage`. Do not reintroduce wildcard CORS in the agent. |
| **Separate window opens instead of kiosk navigation** | `chromium <url>` invoked without `--user-data-dir=/tmp/chromium-profile` starts a second, unmanaged browser instead of navigating the kiosk. | Always pass `--user-data-dir=/tmp/chromium-profile`, and pass the URL after `--` so a `--flag`-shaped URL cannot inject a Chromium switch. There is no DevTools fallback: `--remote-debugging-port` was removed, because an open debugging port is a full remote-control channel for anything that can reach it. |
| **Single-Site Lockdown shows "This page is blocked"** | The custom LMS/exam target URL was configured but its domain was omitted from the Chromium policy allowlist. | `buildEffectiveWhitelist` in `db.ts` automatically extracts and appends the hostname of `tenant.default_url` when mode is `single_url`. Never require a teacher to manually duplicate the target domain in the whitelist. |
| **Broadcast URL shortcuts break or show hardcoded third-party links** | Presets were hardcoded into HTML rather than rendered from tenant data. | Shortcuts must be dynamically loaded from approved portal applications (`portalSites`) plus custom presets stored in the `broadcast_presets` table in D1. |
| **Freeze Screen modal unreachable or nested** | `#lock-modal` was added inside another modal overlay. | All modals (`vnc-modal`, `url-modal`, `lock-modal`, `whitelist-modal`, `portal-modal`, `settings-modal`) must be top-level siblings at depth 0. `test/worker.test.ts` asserts depth 0 for every modal ID. |
| **Broadcast URL shortcut shows "This page is blocked"** | Custom shortcut domains were stored in `broadcast_presets` but omitted from the effective allowlist. | `buildEffectiveWhitelist()` in `db.ts` now extracts and whitelists hostnames from all tenant `broadcast_presets`, and `/api/telemetry` dynamically keeps any active broadcast domain in the client allowlist. |
| **Resetting Broadcast lands on SaaS landing page instead of school portal** | `resetBroadcastToPortal()` sent `origin + "/"` without tenant scoping. | When `resetPortal: true` is passed, `POST /api/command` in `index.ts` authoritatively resolves `portalUrlFor(tenant)`, returning kiosks correctly to their portal or single-site lockdown target. |
| **Single-Site Lockdown URL rejected without scheme** | `safeHttpUrl()` strictly rejected URLs missing `http://` or `https://` (e.g. `canvas.institution.edu`). | `safeHttpUrl()` in `escape.ts` automatically prepends `https://` for scheme-less domains while safely rejecting dangerous schemes like `javascript:` and `data:`. |

