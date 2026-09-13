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
│   │   └── opt/labkiosk/
│   │       ├── setup/                  # First-boot onboarding wizard GUI (HTML/JS)
│   │       ├── extension/              # Manifest V3 auto-hiding top bar & curtain injection
│   │       └── agent/agent.py          # Python 3 background daemon (telemetry & command executor)
│   ├── Dockerfile                      # Cross-platform containerized ISO builder
│   └── build-iso.sh                    # Native Debian/WSL2 build script
│
├── cloudflare-control/                 # Cloudflare Workers Control Plane (Edge SaaS)
│   ├── migrations/                     # Cloudflare D1 SQL migrations
│   ├── src/
│   │   ├── index.ts                    # Edge router, CORS, REST APIs, and telemetry cache
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

### Rule 2: 100% RAM Overlay Protection (`overlayroot="tmpfs"`)
- The client OS is installed on low-cost **12 GB SATA SSDs** with limited write cycles.
- The root filesystem **must remain mounted read-only (`ro`)**.
- Never configure persistent disk logging in `/var/log` or on rootfs. All runtime states, caches, and agent logs must write to `/tmp` (which resides in RAM).

### Rule 3: Native Top-Level Navigation & Auto-Hiding Viewport
- **Never load external educational websites inside an `<iframe>`**. Platforms like Khan Academy and YouTube enforce `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` and will fail with `ERR_BLOCKED_BY_RESPONSE`.
- Chromium must load URLs as top-level native pages.
- The Chrome extension (`content.js`) injects the navigation header into the top frame.
- The top navigation bar **must auto-hide** (`transform: translateY(-100%)`) and appear only when `mouseY <= 12px`.
- Never modify `document.body.style.marginTop`; the webpage must occupy 100% of the viewport with zero vertical scroll overflow.

### Rule 4: Multi-Tenant Scoping & Data Isolation
- Every database query in `db.ts` dealing with devices, commands, sessions, or portal apps **must filter by `tenant_id`**.
- The in-memory telemetry cache is partitioned by tenant ID: `tenantTelemetryCache[tenantKey]`. Never expose cross-tenant devices.
- Support wildcard subdomains: extract the school slug from `host`, `?tenant=` query parameter, or `X-Tenant` header.
- Always provide a fallback to `defaultTenant` for local development when accessing API routes without a subdomain.

### Rule 5: Dynamic Client Collections (No Fixed PC Limits)
- Never hardcode fixed workstation counts (e.g. 40 PCs).
- Workstation cards must be dynamically rendered upon receiving their first heartbeat from `/api/telemetry`.
- Decommissioning a workstation via `/api/clients/remove` must purge it from both the memory cache and D1.

### Rule 6: Zero Placeholders
- ❌ No `// TODO: Implement later`
- ❌ No empty `catch (e) {}` blocks
- ❌ No mock data stubs in production paths. Write fully verified code.

---

## 3. Verification & Testing Playbook

Whenever modifying code, run these commands in order:

### 1. TypeScript Strict Typecheck
```powershell
cmd /c rtk pnpm --prefix "cloudflare-control" exec tsc --noEmit
```
*Expected result:* Exit code 0, zero errors.

### 2. Automated Multi-Tenant Unit Tests
```powershell
cmd /c rtk pnpm --prefix "cloudflare-control" test
```
*Expected result:* 8/8 tests passing (tests use Node 22 native `node:sqlite` D1 mock in `d1_adapter.ts`).

### 3. Docker Kiosk Verification
If the Docker test container (`labkiosk-client-01`) is running:
```powershell
# Copy modified agent or extension into the running container:
cmd /c rtk docker cp distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py labkiosk-client-01:/opt/labkiosk/agent/agent.py

# Restart the agent process:
cmd /c rtk docker exec labkiosk-client-01 pkill -f agent.py

# Inspect agent logs:
cmd /c rtk docker exec labkiosk-client-01 tail -n 25 /tmp/lab-agent.log

# Capture a display screenshot to verify UI:
cmd /c rtk docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/screen.png
```

---

## 4. Known Pitfalls & Solutions

| Issue | Root Cause | Solution |
| :--- | :--- | :--- |
| **`D1_EXEC_ERROR: incomplete input`** | Miniflare/workerd parses multiline SQL in `db.exec()` poorly on Windows CRLF. | Split SQL by `;`, normalize newlines (`replace(/\r\n/g, "\n")`), and execute each statement via `db.prepare(stmt).run()`. |
| **Chromium `Invalid pattern http://127.0.0.1:*`** | Chromium managed policy `URLAllowlist` rejects port wildcards (`:*`). | Use hostname patterns without ports (e.g. `127.0.0.1`, `localhost`, `host.containers.internal`). Chromium matches all ports automatically. |
| **`Running as root without --no-sandbox is not supported`** | Inside Docker, Chromium runs as root. | Always pass `--no-sandbox` when launching Chromium inside containerized environments. |
| **Separate window opens instead of kiosk navigation** | Chromium invoked without `--user-data-dir=/tmp/chromium-profile`. | Always pass `--user-data-dir=/tmp/chromium-profile` or use DevTools HTTP API (`PUT /json/new?<url>`) to navigate the running kiosk instance. |
