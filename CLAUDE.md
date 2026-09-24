# Lab Kiosk: Claude Code entry point

The tool-agnostic rules are in `AGENTS.md` (imported below). The detail is **not** loaded up front:
the subsystem codices (`distro-builder/AGENTS.md`, `cloudflare-control/AGENTS.md`) are authoritative
references, and the procedures are skills in `.claude/skills/` that load when a task matches them.

@AGENTS.md

## Skills

| Load | When the task is… |
|---|---|
| `labkiosk-core` | across client and Worker: telemetry, enrolment, commands, broadcasts, remote control |
| `labkiosk-control` | a Worker route, guard, tenancy, staff or batch-command change |
| `labkiosk-console-ui` | any page the Worker renders (consoles, landing, portal, org homepage, legal) |
| `labkiosk-d1-schema` | a schema change or migration |
| `labkiosk-client` | `agent.py`, the extension, the wizard, i18n, localization, keyboard lockdown |
| `labkiosk-distro` | the ISO build, packages, overlay, bootloaders, installer |
| `labkiosk-simulator` | checking a client change on screen in Docker |

Open the matching codex section when a skill points to it or you need the rationale.

## Quick reference

- Worker: `pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test`
- Client: the `py_compile`, `node --check`, `unittest` and policy `--check` commands in `AGENTS.md` §3.
  On this Windows machine `python3` is the Store stub — run `python`.
- Dev server: `cd cloudflare-control && cp .dev.vars.example .dev.vars && pnpm dev`
- Every new route: a guard **and** a negative test. Every staff route: `staffDelegationProblem()`.
  Every id list: ≤ 500, chunked under D1's 100-parameter limit.
- Every template or script block: the nonce, no inline handlers, no `escapeHtml`/`escapeAttr` in
  client code.
- Every schema change: a new migration **and** `SCHEMA_SQL`; parent-table CHECK changes use the
  cascade-safe rebuild (`labkiosk-d1-schema`).
- Never write build files with a newline-translating tool (Python's `Path.write_text` on Windows);
  shell heredocs can mangle backslashes — write scripts with the file tools.
- Verify UI on a screenshot or in a driven browser, not on a log line.
