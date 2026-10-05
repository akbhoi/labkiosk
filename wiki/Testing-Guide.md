# Testing Guide

What is tested, how to run it, and what you must add when you change something.

---

## Running the suite

```bash
# Strict typecheck: src/ against Workers types, test/ against Node types
pnpm --prefix cloudflare-control run typecheck

# 168 integration and security tests
pnpm --prefix cloudflare-control test
```

Both must exit 0. The tests run against `src/d1_adapter.ts`, backed by **Node 22's native `node:sqlite`** — no Miniflare, no npm database dependency, and `ALLOW_LOCAL_DB=1` to permit the in-memory database.

The typecheck deliberately runs twice, against two TypeScript projects. `tsconfig.json` checks `src/` against `@cloudflare/workers-types` **alone**, which is what catches an accidental dependency on a Node API that would not exist at the edge. `tsconfig.test.json` checks `test/` against `@types/node`.

---

## What the suite covers

### Authorization and isolation

- Unauthenticated access to **every** workstation-control API is rejected.
- An operator at one organization receives `403` for another organization's console, clients, and commands.
- The Super Admin console is refused without a super-admin session.
- An unknown subdomain returns `404` without reflecting the input as markup.
- Only a host under `DEFAULT_DOMAIN` is treated as an organization subdomain.
- `isHostUnder` matches domain boundaries case-insensitively.

### Device enrolment and telemetry

- A wrong enrollment key is refused; a valid one issues a device token.
- Telemetry without a valid device token is rejected.
- Telemetry is scoped to the **token's own tenant**, whatever the body claims.
- Decommissioning revokes the token.
- An oversized thumbnail is dropped rather than stored.
- An enrolled workstation is pointed at its own organization whatever host it used.
- Enrolment works via a custom domain, and via a custom server URL or IP.
- A boot report without a valid device token, or a malformed one, is refused; failures, rollbacks, fallbacks and errors are listed in Errors & Warnings, not the audit log.

### Automatic bug reports

- Only the organization's settings staff can turn them on, only under the current terms version, and only when the platform has the `AI` binding, `GITHUB_ISSUES_TOKEN` and `GITHUB_ISSUES_REPO`.
- The model's summary is written into an issue as inert text; the facts go in a fence nothing can close.
- An issue's status is read back from GitHub: open, in progress, PR created, resolved, closed.
- The Automatic Bug Report Terms are served publicly and name the repository.

### Command delivery

- A broadcast reaches each workstation **exactly once** — the regression the hub's delivery receipts exist to prevent.
- OrgHub: a socket is configured and online at once, commands are pushed once, frames flow only while a console watches, a quiet workstation writes nothing to D1, a stale socket is closed, removal and suspension close sockets, and one organization's hub refuses another's requests.
- A broadcast sets the authoritative `targetUrl` and epoch in telemetry, and reset restores the portal.
- Broadcast state lives in the database rather than worker memory.
- A `navigate` command with a non-`http(s)` URL is rejected.
- An unsupported command action is rejected.

### Output escaping

Hostile strings render inert in every surface:

- a hostile organization name in the Super Admin console;
- a hostile app title on the user portal;
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

Custom domain request → approval → routing by `Host` → disconnection; single-site lockdown with auto-allowlisting; per-organization customisation reflected on the portal; per-tenant broadcast presets; per-organization allowlists kept separate; audit logging of privileged actions; suspend and reactivate; the scheduled housekeeping handler.

---

## What you must add

### For any new route — mandatory

| Test | Asserts |
| :--- | :--- |
| **Anonymous rejection** | `401` without a session or token |
| **Cross-tenant rejection** | `403` or `404` for an admin of another organization |
| **Cross-site CSRF rejection** | `403` for a cookie-authenticated mutation from a foreign origin |
| **Input validation** | Malformed and hostile input is refused or escaped |

A route without these is not finished. The rule exists because the alternative — a route shipped with a guard that was never exercised — is indistinguishable from a route with no guard at all.

### For any schema change

Change both homes, then run the suite. The drift test will tell you if they disagree. → [Database Schema](Database-Schema#the-schema-has-two-homes)

### For any template change

The CSP test renders every page. If you add a `<script>` without a nonce or an `on*=` attribute anywhere, it fails.

---

## Client-side checks

The client is verified by syntax checks, the `distro-builder/tests` unit tests, static analysis, a boot test of the installed disk, and visual inspection.

```bash
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install \
  distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-localization

PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover -s distro-builder/tests -t distro-builder/tests

node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js

python3 distro-builder/tools/generate-chromium-policy.py --check

shellcheck -S warning \
  distro-builder/config/includes.chroot/etc/openbox/autostart \
  distro-builder/docker-build.sh \
  docker-test/entrypoint.sh
```

CI additionally validates that `manifest.json` and the Chromium policy are well-formed JSON.

The unit tests (`distro-builder/tests/test_client.py`) cover the agent's loopback boundary, enrolment and control channel, and the installed disk: the GRUB environment and the one-try boot, the installed boot menu (every entry `--unrestricted`, the try spent before the new image boots, `labkiosk.installed=1` and `noeject`), the health check that confirms or rolls back a new image, the data partition pinned by UUID and never by label, seeding that never follows links, and boot-outcome reporting.

### Boot test of the installed disk

`distro-builder/tests/vm/boot-test.sh` installs a built ISO onto a virtual disk with the real installer, then boots that disk in QEMU (UEFI via OVMF, KVM) and reads the results from `boot/grub/grubenv`:

| Scenario | Proves |
| :--- | :--- |
| `promote` | A good new image boots once, passes the health check and becomes current; the old one becomes previous |
| `broken` | An image with a damaged squashfs fails to boot, reboots by itself (`panic=10`), and the try is spent |
| `recover` | The next boot is the current image again, and it stays up |
| `unhealthy` | An image that boots but whose kiosk never comes up is rebooted away from after the 10-minute health deadline |

```bash
sudo distro-builder/tests/vm/boot-test.sh distro-builder/out/labkiosk-debian12-amd64.iso [workdir]
```

It needs root, `/dev/kvm`, `qemu-system-x86`, `ovmf`, `xorriso`, `squashfs-tools`, `e2fsprogs`, `fdisk` and `python3`, so it does not run on Windows. A screenshot of the VM is saved for every scenario that fails. Legacy BIOS boot of the installed disk is covered only by the GRUB menu unit tests.

An installed kiosk has no shell (getty masked, no SSH). To try a slot by hand, mount `LABKIOSK_ROOT` from another system and run `grub-editenv boot/grub/grubenv set next=<version> next_tries=1`.

### Visual verification

```bash
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png
docker cp labkiosk-client-01:/tmp/verify.png .
```

**Never claim a UI change is complete without inspecting a capture.** The agent logging a command as executed proves only that the agent ran; it does not prove the user saw anything.

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
| `client` | Python compile, client unit tests, `node --check`, shellcheck, JSON validity, Chromium policy drift |

`build-iso.yml` (version tags and manual dispatch) builds the ISO, then runs the boot test above before any GitHub Release is created; a failing scenario uploads the VM screenshots.

`deploy-cloudflare.yml` re-runs the typecheck and the suite before applying migrations and deploying — a failing test never reaches production.

→ [Development Workflow](Development-Workflow) · [Control Plane Internals](Control-Plane-Internals)
