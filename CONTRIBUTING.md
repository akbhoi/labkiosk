# Contributing to Lab Kiosk

Thank you for your interest in contributing to **Lab Kiosk**! Whether you are an operator, developer, systems engineer, or AI agent, your help makes digital education more accessible, secure, and cost-effective for organizations globally.

---

## 🤖 Co-Development with AI Notice

Lab Kiosk was co-developed through human-AI pair programming between the core maintainers and **Antigravity** (Google DeepMind's Advanced AI Assistant). We welcome contributions authored by human developers, AI agents, or humans collaborating with AI.

**AI Contribution Standards:**
1. **Zero Placeholders:** Code submitted must be fully functional and production-ready. No `// TODO: Implement later` or empty stubs.
2. **Strict Verification:** All changes must pass `pnpm run typecheck` with 0 errors and the full test suite via `pnpm test`.
3. **Transparent Disclosure:** If an AI agent was used to author or refactor code, note the model or system in your pull request description.

---

## 🛠️ Development Setup

### 1. Requirements
- Node.js v22+
- `pnpm` (`npm install -g pnpm`)
- Docker & Docker Compose (for client workstation emulation)

### 2. Local Setup
```bash
# Clone your fork
git clone <your-fork-url> labkiosk
cd labkiosk

# Install Cloudflare Worker dependencies
cd cloudflare-control
pnpm install

# Typecheck the worker and the tests (two separate TS projects)
pnpm run typecheck

# Run the test suite (in-memory database, no secrets needed)
pnpm test

# Local secrets for the dev server (the super admin login). With a D1 binding
# present the worker refuses to seed a default account, so this step is required.
cp .dev.vars.example .dev.vars   # edit the values

# Start the dev server with hot-reload (`predev` applies migrations to local D1)
pnpm dev
```

The client side has its own quick checks, which CI runs too:
```bash
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \n  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \n  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
shellcheck -S warning distro-builder/config/includes.chroot/etc/openbox/autostart distro-builder/docker-build.sh docker-test/entrypoint.sh
```

### 3. Emulating Thin Clients
You do not need physical thin clients to test client OS modifications:
```bash
# Launch the Docker Kiosk container (with `pnpm dev` already running)
docker compose up -d
```
Open `http://localhost:6080/vnc.html` (VNC password `labkiosk`) to see the workstation screen. It
boots into the first-boot setup wizard; enrol it the way a real workstation is enrolled, with the
organization subdomain, a workstation name, and the organization's **enrollment key** from the admin console
under **Settings -> Workstation Enrollment Key**.

The agent's API binds to `127.0.0.1` inside the container, exactly as on a real workstation, so drive
the wizard from the noVNC screen rather than from your host browser. If you find yourself wanting to
publish port 8888 to make testing easier, that is the bug this binding exists to prevent.

---

## 📐 Architecture Invariants & Standards

When writing code for Lab Kiosk, you MUST preserve these architectural decisions. For detailed subsystem specifications, consult:
- **Master Architecture Codex:** [`AGENTS.md`](AGENTS.md)
- **Client OS & Distro Builder:** [`distro-builder/AGENTS.md`](distro-builder/AGENTS.md)
- **Cloudflare Control Plane:** [`cloudflare-control/AGENTS.md`](cloudflare-control/AGENTS.md)
- **Core Engineering Skills:** [`skills/`](skills/)

Here is the quick summary of non-negotiable standards:

1. **Zero External NPM Bloat in Cloudflare Worker:**
   - Use native `crypto.subtle` for all cryptographic hashing (PBKDF2-HMAC-SHA256).
   - Use standard `Request` and `Response` Web APIs.
   - Do not pull in heavy third-party routing or auth frameworks; maintain cold-start times under 10ms.

2. **Authorization Is Not Optional:**
   - Every route that reads or changes an organization's data calls `requireTenantAdmin()` from `src/guard.ts`.
     Platform routes call `requireSuperAdmin()`; `/api/telemetry` calls `requireDevice()`.
   - Never resolve a tenant by hand. Call `resolveTenant()`: the `Host` header is authoritative, and a
     `?tenant=` override is honoured only for local dev, a super admin, a session that already owns
     that tenant, or an explicitly public route.
   - A workstation's identity comes from its device token, never from the request body.
   - **Add a negative test with every new route.** A suite that only exercises the happy path is what
     allowed this project to ship with no authorization at all.

3. **Escape Everything Rendered:**
   - Organization names, admin emails and portal card titles are attacker-controlled — they arrive through
     public registration. Server-side, interpolate through `escapeHtml()` / `escapeJson()` from
     `src/escape.ts`; `escapeJson()` is required inside a `<script>` block.
   - Client-side, build DOM nodes and set `textContent`. No `innerHTML` concatenation, no values in
     inline `onclick=` attributes — attach listeners and pass ids via `dataset`.
   - Run any URL you will navigate to, redirect to, or render as `href` through `safeHttpUrl()`.
   - The CSP is nonce-based: every `<script>` in a template carries `nonce="${escapeAttr(nonce)}"`,
     and no template uses an inline event handler attribute (`onclick=`, `onsubmit=`, ...). Use
     `data-action` attributes with one delegated listener, as the landing page and super console do.
     A test renders every page and fails on a script without the nonce or on any `on*=` attribute.
   - Per-isolate memory is a cache, never the source of truth. State a workstation or an operator
     must agree on (the active broadcast, device details) lives in D1.

4. **Fail Closed:**
   - Missing configuration is an error, not a reason to fall back to something weaker.
   - The client agent's local API binds to `127.0.0.1`; `websockify` binds to loopback on the real
     image. Neither may be published on `0.0.0.0`.
   - Chromium is never launched with `--disable-web-security`, and keeps its sandbox in both images.
     `--no-sandbox` is permitted only as the simulator entrypoint's fallback for a container that was
     started as root, which it warns about.

5. **RAM Overlay on Thin Clients (`toram` + `overlayroot="tmpfs"`):**
   - The client runs as a live image copied into RAM; the root filesystem stays read-only so thin-client
     SSDs are never written to.
   - Never write persistent logs to `/var/log` or disk; direct runtime data to `/tmp` (RAM).

6. **Multi-Tenant Scoping:**
   - Every database query touching devices, portal apps, or sessions must be explicitly scoped by `tenant_id`.
   - Never leak telemetry or settings across organization boundaries.
   - The in-memory telemetry cache is a cache; `client_devices` in D1 is the source of truth.

7. **Zero-Margin Floating Viewport:**
   - The kiosk extension must never alter `document.body.style.marginTop` or induce scrollbars.
   - Navigation controls must remain auto-hiding and dismiss completely when the screen is locked.
   - The content script talks to the agent only through the MV3 service worker (`background.js`).
     Moving that `fetch` into the content script would force the agent to send
     `Access-Control-Allow-Origin: *` to every site a user visits.

8. **Dynamic Workstation Collection:**
   - Never hardcode fixed workstation arrays or limits (e.g. 40 PCs).
   - Workstations must be dynamically added upon first heartbeat and removed via user decommission.

9. **Schema Has Two Homes, Keep Them Agreeing:**
   - A change to the database means a **new** numbered file in `migrations/` *and* the matching change
     in `SCHEMA_SQL` in `src/db.ts`, which builds the in-memory database used by tests and `wrangler dev`.
   - A test compares the two and fails on drift. Never edit an already-applied migration.

---

## 🔐 Reporting a Security Issue

Do **not** open a public issue for a vulnerability. Follow the private disclosure process in
[SECURITY.md](SECURITY.md). This project runs in rooms and handles live images of users'
screens, so we would rather hear about a suspected problem early than late.

## 🔄 Pull Request Guidelines

1. **Branch Naming:**
   - `feat/feature-name` for new capabilities
   - `fix/bug-description` for bug fixes
   - `docs/update-info` for documentation improvements
2. **Commit Conventions:** Follow Conventional Commits:
   - `feat: add CK-12 educational preset to portal`
   - `fix: resolve policy allowlist port formatting in agent`
   - `docs: update ISO build instructions for Docker`
3. **Testing:** Before submitting, ensure both of these pass:
   ```bash
   pnpm --prefix cloudflare-control run typecheck
   ```
   ```bash
   pnpm --prefix cloudflare-control test
   ```
4. **Client-side changes:** Shell, Python and extension changes are not covered by the worker test
   suite, so verify them yourself and say how in the PR — `docker compose up -d` plus a screenshot
   from the noVNC session is usually enough. Two things worth knowing before you start:
   - An MV3 extension is read once at browser launch, so copying new files into the container changes
     nothing until Chromium restarts
     (`docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile`; the watchdog
     relaunches it within a second).
   - **Attach the screenshot, not the log line.** The agent logging a command as executed says nothing
     about what the user saw; a broken lock curtain looked perfectly healthy in the logs for an
     entire debugging session.
