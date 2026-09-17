# Testing Guide

What is tested, how to run it, and what you must add when you change something.

---

## Running the suite

```bash
# Strict typecheck: src/ against Workers types, test/ against Node types
pnpm --prefix cloudflare-control run typecheck

# 62 integration and security tests
pnpm --prefix cloudflare-control test
```

Both must exit 0. The tests run against `src/d1_adapter.ts`, backed by **Node 22's native `node:sqlite`** — no Miniflare, no npm database dependency, and `ALLOW_LOCAL_DB=1` to permit the in-memory database.

The typecheck deliberately runs twice, against two TypeScript projects. `tsconfig.json` checks `src/` against `@cloudflare/workers-types` **alone**, which is what catches an accidental dependency on a Node API that would not exist at the edge. `tsconfig.test.json` checks `test/` against `@types/node`.

---

## What the suite covers

### Authorization and isolation

- Unauthenticated access to **every** workstation-control API is rejected.
- A teacher at one school receives `403` for another school's console, clients, and commands.
- The Super Admin console is refused without a super-admin session.
- An unknown subdomain returns `404` without reflecting the input as markup.
- Only a host under `DEFAULT_DOMAIN` is treated as a school subdomain.
- `isHostUnder` matches domain boundaries case-insensitively.

### Device enrolment and telemetry

- A wrong enrollment key is refused; a valid one issues a device token.
- Telemetry without a valid device token is rejected.
- Telemetry is scoped to the **token's own tenant**, whatever the body claims.
- Decommissioning revokes the token.
- An oversized thumbnail is dropped rather than stored.
- An enrolled workstation is pointed at its own school whatever host it used.
- Enrolment works via a custom domain, and via a custom server URL or IP.

### Command delivery

- A broadcast reaches each workstation **exactly once** — the regression that `command_deliveries` exists to prevent.
- A broadcast sets the authoritative `targetUrl` and epoch in telemetry, and reset restores the portal.
- Broadcast state lives in the database rather than worker memory.
- A `navigate` command with a non-`http(s)` URL is rejected.
- An unsupported command action is rejected.

### Output escaping

Hostile strings render inert in every surface:

- a hostile school name in the Super Admin console;
- a hostile app title on the student portal;
- a portal app whose URL is not `http(s)`.

### Browser hardening

- **Every** HTML page carries a strict CSP whose nonce matches every script, and contains **no** inline `on*=` handler.
- A fresh nonce is used on every response.
- Dashboard markup is well formed, so every modal is reachable.

### CSRF and sessions

- A cookie-authenticated mutation from a cross-site origin is refused.
- Sign-out happens only on `POST`, never on a `GET` link.
- A password change ends the account's other sessions.

### Rate limiting and validation

- Repeated failed sign-ins are throttled.
- Repeated failed enrolments from one address are throttled.
- Repeated registrations from one address are throttled.
- Reserved subdomains and implausible emails are rejected at registration.
- A weak password is rejected.
- A scheme-less `host:port` is accepted as a valid URL.

### Fail-closed behaviour

- The worker refuses to run without a database binding unless explicitly allowed.
- It refuses to serve a bound database that has not been migrated.
- It refuses to seed the default super admin against a real database.
- The super-admin password updates when `SUPER_ADMIN_PASSWORD` changes in the environment.

### Schema integrity

- `SCHEMA_SQL` in `db.ts` declares the same tables and columns as `migrations/`.

### Multi-tenant feature coverage

Custom domain request → approval → routing by `Host` → disconnection; single-site lockdown with auto-allowlisting; per-school customisation reflected on the portal; per-tenant broadcast presets; per-school allowlists kept separate; audit logging of privileged actions; suspend and reactivate; the scheduled housekeeping handler.

---

## What you must add

### For any new route — mandatory

| Test | Asserts |
| :--- | :--- |
| **Anonymous rejection** | `401` without a session or token |
| **Cross-tenant rejection** | `403` or `404` for an admin of another school |
| **Cross-site CSRF rejection** | `403` for a cookie-authenticated mutation from a foreign origin |
| **Input validation** | Malformed and hostile input is refused or escaped |

A route without these is not finished. The rule exists because the alternative — a route shipped with a guard that was never exercised — is indistinguishable from a route with no guard at all.

### For any schema change

Change both homes, then run the suite. The drift test will tell you if they disagree. → [Database Schema](Database-Schema#the-schema-has-two-homes)

### For any template change

The CSP test renders every page. If you add a `<script>` without a nonce or an `on*=` attribute anywhere, it fails.

---

## Client-side checks

There is no unit-test harness for the client; it is verified by syntax checks, static analysis, and visual inspection.

```bash
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
```

CI additionally validates that `manifest.json` and the Chromium policy are well-formed JSON.

### Visual verification

```bash
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png
docker cp labkiosk-client-01:/tmp/verify.png .
```

**Never claim a UI change is complete without inspecting a capture.** The agent logging a command as executed proves only that the agent ran; it does not prove the student saw anything.

---

## Manual testing matrix

| Environment | Verifies |
| :--- | :--- |
| **Hyper-V Gen 2 (UEFI)** | GRUB EFI menu, live boot, disk detection, install to VHDX, standalone reboot |
| **VirtualBox (BIOS)** | ISOLINUX menu, live boot, install to VDI, legacy GRUB boot |
| **Docker simulator** | Agent, extension, telemetry, wizard — rapid iteration, no hardware |

The simulator cannot test bootloaders, `overlayroot`, the installer, TTY masking, or Chromium's sandbox. → [Workstation Simulator](Workstation-Simulator#what-the-simulator-cannot-test)

---

## CI

`.github/workflows/ci.yml` runs on every push:

| Job | Does |
| :--- | :--- |
| `images` | Builds both `labkiosk` and `labkiosk-iso-builder` (no push) |
| `worker` | Node 22, pnpm, typecheck, integration tests |
| `client` | Python compile, `node --check`, shellcheck, JSON validity, Chromium policy drift |

`deploy-cloudflare.yml` re-runs the typecheck and the suite before applying migrations and deploying — a failing test never reaches production.

→ [Development Workflow](Development-Workflow) · [Control Plane Internals](Control-Plane-Internals)
