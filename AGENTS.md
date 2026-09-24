# AI Agent Codex — Lab Kiosk

> Lab Kiosk turns any computer into a locked-down, centrally managed browser workstation for an
> **organization** — a company, public body, library or school. It was co-developed through
> human-AI pair programming (Antigravity, then Claude Code). Every AI agent working here (Claude,
> Codex, Copilot, Cursor, Gemini, Antigravity…) follows this codex and the subsystem codices.

This file is deliberately short: the rules every change must respect, and where the detail lives.

| Detail | Where |
|---|---|
| Client OS, agent, extension, wizard, installer, ISO build | [`distro-builder/AGENTS.md`](distro-builder/AGENTS.md) (authoritative) |
| Cloudflare Worker, D1, consoles, security | [`cloudflare-control/AGENTS.md`](cloudflare-control/AGENTS.md) (authoritative) |
| Task procedures, loaded on demand | [`.agents/skills/`](.agents/skills/) — see the table below |

## Skills — open the one that matches the task

| Task | Skill file |
|---|---|
| Client ↔ Worker contracts: telemetry, enrolment, commands, broadcast state, remote control | [`.agents/skills/labkiosk-core/SKILL.md`](.agents/skills/labkiosk-core/SKILL.md) |
| Worker routes, guards, tenancy, staff delegation, batch commands, tests | [`.agents/skills/labkiosk-control/SKILL.md`](.agents/skills/labkiosk-control/SKILL.md) |
| Consoles, landing, User Portal, organization homepage, legal pages | [`.agents/skills/labkiosk-console-ui/SKILL.md`](.agents/skills/labkiosk-console-ui/SKILL.md) |
| Database schema and migrations | [`.agents/skills/labkiosk-d1-schema/SKILL.md`](.agents/skills/labkiosk-d1-schema/SKILL.md) |
| Agent, extension, wizard, i18n, localization, keyboard lockdown | [`.agents/skills/labkiosk-client/SKILL.md`](.agents/skills/labkiosk-client/SKILL.md) |
| ISO build, packages, overlay, bootloaders, installer | [`.agents/skills/labkiosk-distro/SKILL.md`](.agents/skills/labkiosk-distro/SKILL.md) |
| Seeing a client change work in the Docker simulator | [`.agents/skills/labkiosk-simulator/SKILL.md`](.agents/skills/labkiosk-simulator/SKILL.md) |

This file is the one entry point for every tool; there is no `CLAUDE.md`. Nothing below is loaded up
front: open the skill that matches the task, and the matching codex section when a skill points to
it or you need the rationale.

## 1. Architecture

```text
labkiosk/
├── distro-builder/          Debian 12 live-build image, installer, hooks, Chromium policy
│   └── config/includes.chroot/
│       ├── opt/labkiosk/    agent/agent.py (loopback API :8888), extension/ (MV3), setup/wizard.html, i18n/
│       └── usr/local/…      bin/labkiosk-install, sbin/labkiosk-localization
├── cloudflare-control/      Cloudflare Worker + D1
│   ├── migrations/          0001..0011 (never edit an applied one)
│   ├── src/                 index.ts (router), guard.ts, escape.ts, db.ts (SCHEMA_SQL), auth.ts,
│   │                        ui_*.ts (one module per page), ui_tokens.ts, ui_layout.ts
│   └── test/                worker.test.ts, dump_admin_html.ts, dev_server.ts
├── Dockerfile, docker-compose.yml, docker-test/   workstation simulator
├── docs/, wiki/             deployment, API and user documentation
└── .agents/skills/          on-demand procedures (above)
```

The workstation agent sends a heartbeat every 3 s (`POST /api/telemetry`, device bearer token);
the reply carries the allowlist, the target URL, broadcast state and queued commands (`lock`,
`unlock`, `navigate`, `reload`, `reboot`, `shutdown`, `clear-session`, `mute`). Enrolment exchanges
an organization's enrollment key for the device token. Remote control is loopback VNC →
websockify → Cloudflare Tunnel. Full contracts: `labkiosk-core`.

## 2. Invariants (zero exceptions)

1. **Zero runtime npm dependencies in the Worker.** Crypto is `crypto.subtle` only (PBKDF2-HMAC-SHA256,
   100 000 iterations, 32-byte salt). No routers, auth frameworks or ORMs.
2. **RAM overlay on the client.** `overlayroot="tmpfs:recurse=0"`; the root filesystem is read-only;
   only the `LABKIOSK_DATA` partition at `/etc/labkiosk` persists on an installed disk.
3. **Top-level navigation only.** Never load external sites in an `<iframe>`; the extension's bar and
   curtain live in a Shadow DOM; only `background.js` talks to the agent.
4. **Tenant isolation.** Every query touching tenant data filters by `tenant_id`; state two requests
   must agree on lives in D1, never module memory. Every route resolves its tenant with
   `resolveTenant()` and is guarded (`requireTenantPermission` / `requireTenantAdmin` /
   `requireSuperAdmin` / `requireDevice`) **and** has negative tests. Super admins see only the
   `demo` organization.
5. **Staff delegation never escalates.** Roles `org_admin`, `sub_admin`, `operator`, `assistant`,
   `content_manager`; permissions `workstations`, `broadcast`, `portal`, `whitelist`, `staff`,
   `settings`; `*` is never stored; `staffDelegationProblem()` guards every staff change.
6. **Escape everything; no inline handlers.** Server: `escapeHtml`/`escapeJson`/`safeHttpUrl`.
   Client: DOM nodes and `textContent` (escape helpers are server-only). Every `<script>` carries the
   CSP nonce. Classes must be declared in `ui_layout.ts`; tokens only in `ui_tokens.ts`.
7. **The schema has two homes** — a new migration **and** `SCHEMA_SQL`. A CHECK change on a parent
   table uses the cascade-safe rebuild: a plain `DROP TABLE users` cascade-deletes every organization.
8. **Loopback-only agent.** `127.0.0.1:8888`; mutating endpoints accept loopback origins and the
   extension's pinned origin only; installed-disk admin actions need the boot-password token.
   Validation regexes anchor with `\Z` (never `$`, never `\\Z` in a raw string).
9. **Unattended boot.** A workstation boots straight into the kiosk; never add a prompt to the normal
   boot path.
10. **Fail closed; zero placeholders.** Missing config is an error; no TODO stubs, no empty
    `catch`/`except`, no invented checksums or pins.
11. **The simulator is hardened too.** Unprivileged `kiosk` user, Chromium sandbox on, read-only root,
    `cap_drop: ALL` + `SYS_CHROOT`, noVNC on `127.0.0.1`; `--no-sandbox` only as the warned root fallback.
12. **LF line endings** everywhere (`.gitattributes`); never write files with a newline-translating tool.
13. **Organizations, not schools.** Say organization, operator/staff, user, User Portal, page/broadcast —
    never school, teacher, student, lesson or classroom (a test enforces it on the consoles, portal and
    organization homepage). **Statements about the license describe `LICENSE`**: free only for
    accredited educational institutions and non-commercial evaluation up to 45 computers; everyone else
    needs a commercial or subscriber license.

## 3. Verify

```bash
pnpm --prefix cloudflare-control run typecheck
pnpm --prefix cloudflare-control test
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install \
  distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-localization
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover -s distro-builder/tests -t distro-builder/tests
python3 distro-builder/tools/generate-chromium-policy.py --check
```

`PYTHONPYCACHEPREFIX` keeps `__pycache__` out of the image overlay. Tests check markup and contracts,
not behaviour: verify UI changes by driving the page in a browser, and kiosk changes with a screenshot
from the simulator.

## 4. Quick reference

- Dev server: `cd cloudflare-control && cp .dev.vars.example .dev.vars && pnpm dev`
- Every new route: a guard **and** a negative test. Every staff route: `staffDelegationProblem()`.
  Every id list: ≤ 500, chunked under D1's 100-parameter limit.
- Every template or script block: the nonce, no inline handlers, no `escapeHtml`/`escapeAttr` in
  client code.
- Every schema change: a new migration **and** `SCHEMA_SQL`; parent-table CHECK changes use the
  cascade-safe rebuild (`labkiosk-d1-schema`).
- On Windows, `python3` may be the Microsoft Store stub — run `python`. Never write build files with
  a newline-translating tool (Python's `Path.write_text` on Windows), and shell heredocs can mangle
  backslashes — write scripts with a file tool.
