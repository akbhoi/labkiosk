# LabKiosk — AI Agent Instructions & Contributor Guide

Welcome to **Lab Kiosk**. This repository is an open, production-grade platform co-developed through human-AI pair programming.

To ensure consistency, security, and architectural integrity, all AI agents and human contributors must follow the invariants and procedures outlined below. The authoritative, detailed rules live in the codices; this page is the orientation and the short list.

- Master codex: [`AGENTS.md`](../AGENTS.md)
- Client OS & installer: [`distro-builder/AGENTS.md`](../distro-builder/AGENTS.md)
- Control plane: [`cloudflare-control/AGENTS.md`](../cloudflare-control/AGENTS.md)
- Operating procedures: [`.agents/skills/labkiosk-core/SKILL.md`](skills/labkiosk-core/SKILL.md)


## 🧩 Skills (open the one that matches the task)

| Skill | Use it for |
|---|---|
| [`labkiosk-core`](skills/labkiosk-core/SKILL.md) | client ↔ Worker contracts: telemetry, enrolment, commands, broadcast state, remote control |
| [`labkiosk-control`](skills/labkiosk-control/SKILL.md) | Worker routes, guards, tenancy, staff delegation, batch commands, route tests |
| [`labkiosk-console-ui`](skills/labkiosk-console-ui/SKILL.md) | consoles, landing, User Portal, organization homepage, legal pages; browser verification |
| [`labkiosk-d1-schema`](skills/labkiosk-d1-schema/SKILL.md) | schema changes, migrations, cascade-safe table rebuilds, production migration |
| [`labkiosk-client`](skills/labkiosk-client/SKILL.md) | agent.py, extension, wizard, i18n, localization, keyboard lockdown |
| [`labkiosk-distro`](skills/labkiosk-distro/SKILL.md) | ISO build, packages, RAM overlay, bootloaders, disk installer |
| [`labkiosk-simulator`](skills/labkiosk-simulator/SKILL.md) | seeing a client change work in the Docker simulator |

Each skill is a short procedure; the codices stay authoritative. They live in `.agents/skills/` so every tool can open them by path.

---

## 🧭 Repository Orientation

The repository is partitioned into two independent subsystems plus a workstation simulator:

1. **Client Operating System & Distro Builder (`distro-builder/`)**:
   - Debian 12 (Bookworm) Live-Build pipeline; only packages named in `kiosk.list.chroot` ship (no recommends).
   - Hybrid UEFI (GRUB EFI) + BIOS (ISOLINUX) boot menus; installed disks get both bootloaders.
   - 100% RAM overlay protection (`overlayroot="tmpfs:recurse=0"`); only the `LABKIOSK_DATA` partition at `/etc/labkiosk` persists.
   - Automated disk installer (`/usr/local/bin/labkiosk-install`): JSON on stdout, logs on stderr.
   - Python 3 agent (`agent.py`), standard library only, binding strictly to loopback `127.0.0.1:8888`.
   - Chromium Manifest V3 extension: `content.js` (top bar & lock curtain in Shadow DOM) talks only to `background.js`, the sole loopback caller.
   - Detailed specification: [`distro-builder/AGENTS.md`](../distro-builder/AGENTS.md)
   - Specialized skill: [`.agents/skills/labkiosk-distro/SKILL.md`](skills/labkiosk-distro/SKILL.md)

2. **Cloudflare SaaS Control Plane (`cloudflare-control/`)**:
   - Cloudflare Workers edge control plane (`src/index.ts`).
   - Cloudflare D1 SQL database with numbered migrations (`migrations/0001..0013`) mirrored in `SCHEMA_SQL`.
   - Pure Web Crypto `PBKDF2-HMAC-SHA256` authentication (0 runtime npm dependencies).
   - Strict multi-tenant authorization guards (`src/guard.ts`).
   - Nonce-based Content Security Policy (CSP) and output escaping (`src/escape.ts`).
   - Organization console: 4-module rail (Workstations, Apps & Web, Staff, Settings), one `ui_admin_<page>.ts` per page, design tokens declared once in `ui_tokens.ts`.
   - Detailed specification: [`cloudflare-control/AGENTS.md`](../cloudflare-control/AGENTS.md)
   - Specialized skill: [`.agents/skills/labkiosk-control/SKILL.md`](skills/labkiosk-control/SKILL.md)

3. **Workstation Simulator** (root `Dockerfile`, `docker-compose.yml`, `docker-test/`): an unprivileged, sandboxed Chromium kiosk used to verify client changes visually.

---

## ⚠️ Core Invariants (Do Not Violate)

**Whole platform**

- **Fail Closed**: Missing configuration, invalid tokens, or unverified checksums/pins fail loudly — never fall back to an insecure default.
- **Zero Placeholders**: no `TODO` stubs, no empty `catch`/`except`, no mock data in production code.
- **LF Line Endings**: `.gitattributes` pins everything to `eol=lf`; a CRLF hook dies with `$'\r': command not found`. Never write files with a newline-translating tool (e.g. Python's `Path.write_text` on Windows).

**Client OS**

- **100% RAM Overlay**: all runtime writes divert to RAM `tmpfs`; the root filesystem stays read-only.
- **Unattended Boot**: a workstation must boot straight into the kiosk. Never add a password prompt to the normal boot path (`--unrestricted` stays unconditional).
- **Top-Level Navigation Only**: never embed external approved web apps in `<iframe>` tags.
- **Loopback Only**: the agent binds `127.0.0.1`; mutating endpoints accept only loopback origins and the extension's pinned origin.
- **Anchor validation regexes with `\Z`**, never `$` (which also matches before a trailing newline).
- **Chromium policy is generated**: edit `usr/share/labkiosk/chromium-policy-base.json`, never the generated `policies.json`.

**Control plane**

- **Zero NPM Dependencies in Worker**: use Web Crypto (`crypto.subtle`) for hashing.
- **Multi-Tenant Data Isolation**: every query filters by `tenant_id`; consensus state lives in D1, not isolate memory.
- **Every route is guarded** (`resolveTenant()` plus `requireTenantAdmin()` / `requireTenantPermission()` / `requireSuperAdmin()` / `requireDevice()`) **and has negative tests** (anonymous, cross-tenant, cross-site `Origin`, invalid input).
- **Staff delegation never escalates**: roles and permissions are validated against fixed lists, `*` is never stored, and staff routes go through `staffDelegationProblem()`.
- **Bounded batches**: id lists are capped at 500 and chunked under D1's 100-parameter limit.
- **The Schema Has Two Homes**: a new file in `migrations/` AND the mirror in `SCHEMA_SQL` (`src/db.ts`).
- **Cascade-safe rebuilds**: a CHECK change on `users`/`tenants` follows `0011_organization_vocabulary.sql` (hold, drop leaves-first, recreate, copy back); a plain `DROP TABLE` cascade-deletes every organization.
- **Organization vocabulary**: organization, operator/staff, user, User Portal — never school, teacher, student or lesson (tested). License statements must match `LICENSE`: free only for accredited educational institutions up to 45 computers.
- **Escape Everything**: server-side via `escapeHtml()`/`escapeJson()`; client-side build DOM nodes with `textContent` (`escapeHtml`/`escapeAttr` do not exist in the browser); URLs pass `safeHttpUrl()`.
- **Nonce CSP, Zero Inline Event Handlers**: every `<script>` carries the response nonce; use `data-action` attributes and delegated listeners.
- **Client API calls go through `labkioskApi(path)`**, never a bare `fetch("/api/...")`.
- **Declared classes only**: every CSS class a page renders is declared in `ui_layout.ts`; the tests fail otherwise.

---

## 🛠️ Verification Commands

Always run these commands before submitting changes:

```bash
# 1. Cloudflare Control Plane
pnpm --prefix cloudflare-control run typecheck
pnpm --prefix cloudflare-control test

# 2. Client Distro & Installer Syntax (PYTHONPYCACHEPREFIX keeps __pycache__ out of the image)
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js

# 3. Client tests and the generated Chromium policy
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover -s distro-builder/tests -t distro-builder/tests
python3 distro-builder/tools/generate-chromium-policy.py --check
```

Tests prove markup and contracts, not that a page works. Verify UI changes visually: console pages by driving them in a browser (`cd cloudflare-control && cp .dev.vars.example .dev.vars && pnpm dev`) and reading the browser console; kiosk changes by a screenshot from the simulator.
