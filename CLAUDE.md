# Lab Kiosk: Claude Code entry point

The engineering rules for this repository are tool-agnostic and live in `AGENTS.md`; the
operating procedures (how to verify, how to drive the Docker simulator, known pitfalls) live in
the skill below. Both are imported here so Claude Code loads them automatically.

@AGENTS.md
@skills/labkiosk-core/SKILL.md

## Quick reference

- Worker: `pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test`
- Client syntax: `python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py`
  and `node --check` on both files in `distro-builder/config/includes.chroot/opt/labkiosk/extension/`
- Dev server: `cd cloudflare-control && cp .dev.vars.example .dev.vars && pnpm dev`
- Every new route: a guard from `src/guard.ts` **and** a negative test.
- Every new template or script block: the response nonce, no inline event handlers.
- Every schema change: a new file in `migrations/` **and** the mirror in `SCHEMA_SQL` (`src/db.ts`).
- Verify UI changes on a screenshot from the simulator, not on a log line.
