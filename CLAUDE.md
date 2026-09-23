# Lab Kiosk: Claude Code entry point

The engineering rules for this repository are tool-agnostic and live in `AGENTS.md` and its subsystem codices:
- Master Codex: `AGENTS.md`
- Client Distro & Installer: `distro-builder/AGENTS.md`
- Cloudflare Control Plane: `cloudflare-control/AGENTS.md`

The operating procedures live in the specialized skills under `skills/`. Both are imported here so Claude Code loads them automatically.

@AGENTS.md
@distro-builder/AGENTS.md
@cloudflare-control/AGENTS.md
@skills/labkiosk-core/SKILL.md
@skills/labkiosk-distro/SKILL.md
@skills/labkiosk-control/SKILL.md

## Quick reference

- Worker: `pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test`
- Client syntax:
  `PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`
  (the cache prefix keeps `__pycache__` out of the image overlay)
  and `node --check` on both files in `distro-builder/config/includes.chroot/opt/labkiosk/extension/`
- Client tests:
  `PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover -s distro-builder/tests -t distro-builder/tests`
- Chromium policy: `python3 distro-builder/tools/generate-chromium-policy.py --check` — the static
  policy is declared once in `usr/share/labkiosk/chromium-policy-base.json`; never hand-edit the
  generated `etc/chromium/policies/managed/policies.json`.
- Line endings: this repo builds a Linux image, so `.gitattributes` pins every script, hook and
  config to `eol=lf`. Never write these files with a tool that translates newlines (Python's
  `Path.write_text` does, on Windows) — a CRLF hook dies with `$'\r': command not found`.
- Dev server: `cd cloudflare-control && cp .dev.vars.example .dev.vars && pnpm dev`
- Every new route: a guard from `src/guard.ts` **and** a negative test.
- Every new template or script block: the response nonce, no inline event handlers, and no
  `escapeHtml`/`escapeAttr` in client code (server-only; build DOM nodes instead).
- Every staff route: `staffDelegationProblem()` in `src/index.ts` — a delegate never grants beyond
  their own permissions. Every id-list route: capped at 500 and chunked under D1's 100-parameter limit.
- Every schema change: a new file in `migrations/` **and** the mirror in `SCHEMA_SQL` (`src/db.ts`).
- Verify UI changes on a screenshot from the simulator, not on a log line. For the consoles, drive
  the page in a browser and read its console: the test suite checks markup, not whether scripts run.
