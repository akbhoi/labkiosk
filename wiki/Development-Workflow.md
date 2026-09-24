# Development Workflow

How to set up, change, verify, and contribute to Lab Kiosk.

---

## Setup

```bash
git clone https://github.com/akbhoi/labkiosk
cd labkiosk/cloudflare-control
pnpm install

pnpm run typecheck
pnpm test

cp .dev.vars.example .dev.vars   # edit the values
pnpm dev
```

Requirements: Node.js v22+, pnpm v9+, and a rootful Docker engine with Compose v2 for the simulator.

---

## The verification triangle

Run all three before you commit. CI runs the same checks, so a failure here is a failure there.

```bash
# 1. Worker
pnpm --prefix cloudflare-control run typecheck
pnpm --prefix cloudflare-control test

# 2. Client syntax
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
python3 distro-builder/tools/generate-chromium-policy.py --check
shellcheck -S warning \
  distro-builder/config/includes.chroot/etc/openbox/autostart \
  distro-builder/docker-build.sh \
  docker-test/entrypoint.sh

# 3. Visual, for any UI change
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png
docker cp labkiosk-client-01:/tmp/verify.png .
```

`PYTHONPYCACHEPREFIX` is not optional: without it `py_compile` writes `__pycache__` directories *inside* `config/includes.chroot`, and live-build copies whatever is on disk straight into the ISO.

---

## Working on the control plane

1. Read `src/types.ts` before changing an API contract.
2. Read `src/guard.ts` and `src/escape.ts` before adding a route. Every route resolves its tenant and carries a guard; every rendered value is escaped. There are no exceptions, and the test suite asserts both.
3. Before touching a `ui*.ts` template: every `<script>` carries `nonce="${escapeAttr(nonce)}"`, and there are no inline `on*=` handlers — only `data-action` attributes with a delegated listener.
4. State two requests must agree on goes in D1, never a module-level variable.
5. Schema change → a **new** numbered migration **and** the mirror in `SCHEMA_SQL`.
6. **Add negative tests for every route you add.** This is mandatory, not encouraged.
7. Typecheck, test, and try it in a browser with `pnpm dev`.

→ [Control Plane Internals](Control-Plane-Internals#adding-a-route-the-checklist)

---

## Working on the client

1. Edit the file under `distro-builder/config/includes.chroot/`.
2. Syntax-check it.
3. Push it into the running simulator and restart the right process:

   ```bash
   # Agent
   docker cp .../agent/agent.py labkiosk-client-01:/opt/labkiosk/agent/agent.py
   docker exec labkiosk-client-01 pkill -f agent.py

   # Extension (MV3 is parsed at browser launch)
   docker cp .../extension labkiosk-client-01:/opt/labkiosk/
   docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile
   ```

4. Read `/tmp/lab-agent.log` and take a screenshot.
5. For anything about booting, bootloaders, `overlayroot`, or the installer, build the ISO and test in a VM. The simulator cannot cover those.

→ [Workstation Simulator](Workstation-Simulator) · [Building the ISO](Building-the-ISO)

---

## Coding standards

### Zero placeholders

- No `// TODO: Implement later`
- No empty `catch (e) {}` blocks
- No mock data stubs in production code
- No unverified constants — cryptographic checksums and pins fail closed rather than guessing

### Fail closed

Missing configuration is an error, not a reason to fall back to something weaker. If you find yourself writing a default for a security-relevant value, stop.

### Line endings

`.gitattributes` pins every script, hook, and config to `eol=lf`, because this repository builds a Linux image. A CRLF hook dies with `$'\r': command not found`. Never write these files with a tool that translates newlines — Python's `Path.write_text` does, on Windows.

### Make the minimal correct change

Prefer a small, targeted fix over rewriting something that already works. Each of the invariants in `AGENTS.md` exists because something broke; changing one means understanding why it is there.

---

## The codices

Architectural rules are tool-agnostic and live in the repository:

| Document | Scope |
| :--- | :--- |
| `AGENTS.md` | Master: cross-cutting contracts and global invariants |
| `distro-builder/AGENTS.md` | Client OS, installer, extension, ISO pipeline |
| `cloudflare-control/AGENTS.md` | Worker, D1, auth, UI templates |
| `.agents/skills/labkiosk-*/SKILL.md` | Task procedures for AI assistants (core, control, console-ui, d1-schema, client, distro, simulator), loaded on demand |

Read the relevant codex before an architectural change. They record not just the rule but the failure that produced it.

---

## AI contributions

Lab Kiosk is openly co-developed with AI assistants, and contributions authored by humans, AI agents, or both are welcome under three conditions:

1. **Zero placeholders.** Submitted code is production-ready.
2. **Strict verification.** `pnpm run typecheck` clean and the full suite passing.
3. **Transparent disclosure.** Note the model or system in the pull request description.

---

## Pull requests

**Before opening:**

- All three verification legs pass.
- New routes have negative tests.
- Schema changes touch both homes.
- UI changes have a screenshot.
- The relevant `AGENTS.md` still holds — or your PR explains why it changed.

**In the description:** what changed, why, how you verified it, and any AI involvement. The repository has a PR template; fill in its sections.

**CI** runs on every push: both Docker images build, the worker is typechecked and tested, and the client syntax, shellcheck, JSON, and Chromium-policy checks all run.

---

## Release flow

| Trigger | Workflow | Result |
| :--- | :--- | :--- |
| Push to `main` touching `cloudflare-control/**` | `deploy-cloudflare.yml` | Typecheck → test → apply remote migrations → `wrangler deploy` |
| Push to `main` or a `v*` tag | `docker-publish.yml` | Publishes `labkiosk` and `labkiosk-iso-builder` to GHCR |
| A `v*` tag | `build-iso.yml` | Builds the ISO, verifies the checksum, creates a GitHub Release |
| Any push | `ci.yml` | The full verification triangle |

---

## Reporting problems

- **Bugs and features:** [GitHub issues](https://github.com/akbhoi/labkiosk/issues), using the templates.
- **Security vulnerabilities:** never in a public issue — use the Security tab → Report a vulnerability. → [Security Model](Security-Model#reporting-a-vulnerability)

---

## Licensing

Contributions and code use are subject to the **LabKiosk Software License (Source-Available)**: free for accredited schools and non-profits, commercial license required for for-profit resale, SaaS hosting, or MSP use.

→ [Testing Guide](Testing-Guide) · [Control Plane Internals](Control-Plane-Internals) · [Client Agent](Client-Agent)
