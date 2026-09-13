# Contributing to Lab Kiosk

Thank you for your interest in contributing to **Lab Kiosk**! Whether you are a teacher, developer, systems engineer, or AI agent, your help makes digital education more accessible, secure, and cost-effective for schools globally.

---

## 🤖 Co-Development with AI Notice

Lab Kiosk was co-developed through human-AI pair programming between the core maintainers and **Antigravity** (Google DeepMind's Advanced AI Assistant). We welcome contributions authored by human developers, AI agents, or humans collaborating with AI.

**AI Contribution Standards:**
1. **Zero Placeholders:** Code submitted must be fully functional and production-ready. No `// TODO: Implement later` or empty stubs.
2. **Strict Verification:** All changes must pass `tsc --noEmit` with 0 errors and all unit tests via `pnpm test`.
3. **Transparent Disclosure:** If an AI agent was used to author or refactor code, note the model or system in your pull request description.

---

## 🛠️ Development Setup

### 1. Requirements
- Node.js v22+
- `pnpm` (`npm install -g pnpm`)
- Docker & Docker Compose (for client workstation emulation)

### 2. Local Setup
```bash
# Clone the repository
git clone https://github.com/yourusername/labkiosk.git
cd labkiosk

# Install Cloudflare Worker dependencies
cd cloudflare-control
pnpm install

# Run the test suite
pnpm test

# Start the dev server with hot-reload
pnpm dev
```

### 3. Emulating Thin Clients
You do not need physical thin clients to test client OS modifications:
```bash
# Launch the Docker Kiosk container
docker compose up -d

# View the live workstation screen in your browser
http://localhost:6080/vnc.html
```

---

## 📐 Architecture Invariants & Standards

When writing code for Lab Kiosk, you MUST preserve these architectural decisions:

1. **Zero External NPM Bloat in Cloudflare Worker:**
   - Use native `crypto.subtle` for all cryptographic hashing (PBKDF2-HMAC-SHA256).
   - Use standard `Request` and `Response` Web APIs.
   - Do not pull in heavy third-party routing or auth frameworks; maintain cold-start times under 10ms.

2. **RAM Overlay on Thin Clients (`overlayroot="tmpfs"`):**
   - The OS root filesystem must always be mounted read-only (`ro`) on physical installations to prevent write wear on 12 GB SATA SSDs.
   - Never write persistent logs to `/var/log` or disk; direct runtime data to `/tmp` (RAM).

3. **Multi-Tenant Scoping:**
   - Every database query touching devices, portal apps, or sessions must be explicitly scoped by `tenant_id`.
   - Never leak telemetry or settings across school boundaries.

4. **Zero-Margin Floating Viewport:**
   - The kiosk extension must never alter `document.body.style.marginTop` or induce scrollbars.
   - Navigation controls must remain auto-hiding and dismiss completely when the screen is locked.

5. **Dynamic Workstation Collection:**
   - Never hardcode fixed workstation arrays or limits (e.g. 40 PCs).
   - Workstations must be dynamically added upon first heartbeat and removed via user decommission.

---

## 🔄 Pull Request Guidelines

1. **Branch Naming:**
   - `feat/feature-name` for new capabilities
   - `fix/bug-description` for bug fixes
   - `docs/update-info` for documentation improvements
2. **Commit Conventions:** Follow Conventional Commits:
   - `feat: add CK-12 educational preset to portal`
   - `fix: resolve policy allowlist port formatting in agent`
   - `docs: update ISO build instructions for WSL2`
3. **Testing:** Ensure `pnpm --prefix cloudflare-control test` passes and `tsc --noEmit` succeeds before submitting your PR.
