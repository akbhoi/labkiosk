# Troubleshooting

Symptoms, root causes, and fixes, grouped by where the problem shows up. Nearly every entry here is a mistake that was actually made.

---

## Control plane

| Symptom | Root cause | Fix |
| :--- | :--- | :--- |
| `SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set` | There is no default super admin once a D1 binding exists | `wrangler secret put` both |
| `The D1 database is missing the current schema` | Migrations not applied | `wrangler d1 migrations apply labkiosk-db --remote` (or `--local`) |
| `No D1 database bound` on startup | `env.DB` missing | Bind `DB` in `wrangler.jsonc`, or set `ALLOW_LOCAL_DB=1` for local dev and tests only |
| `D1_EXEC_ERROR: incomplete input` | Miniflare/workerd parses multiline SQL poorly with CRLF | Split on `;`, `replace(/\r\n/g, "\n")`, run each via `db.prepare(stmt).run()` |
| `Columns of "x" differ between SCHEMA_SQL and migrations/` | The two homes of the schema drifted | Change **both**: a new file in `migrations/` and the mirror in `SCHEMA_SQL` |
| Env vars reset after deploy | A `vars` block in `wrangler.jsonc` overrides dashboard settings | Remove it; manage production values in the dashboard / `wrangler secret` |
| Custom domain 404s | Cloudflare is not routing that hostname to the worker | Proxied `CNAME` into your zone, or a Cloudflare for SaaS custom hostname |

---

## Teacher console UI

| Symptom | Root cause | Fix |
| :--- | :--- | :--- |
| A button does nothing; console says *"Refused to execute inline event handler"* | A template gained an `on*=` attribute; the nonce CSP blocks it | `data-action` + a delegated listener, or `addEventListener` |
| A script block silently does not run | The `<script>` lacks `nonce="${escapeAttr(nonce)}"` | Pass the response nonce to the renderer and stamp it |
| Resetting Broadcast lands on the SaaS landing page instead of the school portal | `resetBroadcastToPortal()` sent `origin + "/"` without tenant scoping | `POST /api/command` resolves `portalUrlFor(tenant)` authoritatively |
| Workstations disagree about the active broadcast | Broadcast state was in isolate memory, which differs per colo | It lives in `tenants.broadcast_url` / `broadcast_epoch` in D1 |
| A Single-Site Lockdown URL is rejected | No scheme, e.g. `canvas.school.edu` | None needed — `safeHttpUrl()` prepends `https://`. If it is still rejected the host itself is malformed |

---

## Workstation enrolment

| Symptom | Root cause | Fix |
| :--- | :--- | :--- |
| Enrolment rejected with a valid-looking key | The school's key is empty, or the school is `pending`/`suspended` | Generate a key in Settings; have a super admin approve the school |
| Enrolment rejected after several tries | Failed attempts from that address are throttled | Wait, then retry with the correct key |
| Workstation never appears on the dashboard | Not enrolled, or its token was revoked | Re-run the wizard with the current key. Check `/tmp/lab-agent.log` for `401` |
| Freshly enrolled kiosk shows "This page is blocked" | Chromium reads managed policy only at startup | The agent sets `pendingBrowserRestart` and restarts the browser after the next sync — wait for it |
| Enrolment forgotten after a reboot | `overlayroot="tmpfs"` sends every write to RAM, including `/etc/labkiosk/config.json` | The installer creates `LABKIOSK_DATA` and mounts it at `/etc/labkiosk`. On an older image, enrol from the live session **before** installing |
| Wizard shows the installer tab on an installed machine | `/api/status` returns `"isLive": True` as a literal instead of the computed value | Cosmetic — `POST /api/install` still refuses with `400`. → [Client Agent](Client-Agent#session-awareness) |

---

## Client OS and browser

| Symptom | Root cause | Fix |
| :--- | :--- | :--- |
| Nav bar and lock curtain vanish; Chromium logs *"Loading of unpacked extensions is disabled by the administrator"* | A blanket `ExtensionInstallBlocklist: ["*"]` in the managed policy | Remove it. An `ExtensionInstallAllowlist` entry does **not** override it |
| A site is blocked that should be allowed | Not on the effective allowlist, or policy not reloaded yet | Add the domain in Settings; the browser restarts on the next sync |
| A Chromium policy rule is silently ignored | An invalid pattern like `http://localhost:*` or `127.0.0.1:*` | Use the bare host: `localhost`, `127.0.0.1`, `host.containers.internal`. Omitting the port matches all ports |
| A policy key you added has vanished | It was added to only one of the two consumers of the policy base | Edit `usr/share/labkiosk/chromium-policy-base.json`, never the generated file; verify with `generate-chromium-policy.py --check` |
| Black screen on boot | `quiet loglevel=3` suppressed boot logs and PAM autologin was locked | `consoleblank=0` instead, `passwd -d kiosk`, pre-seed live-config markers |
| Boots to a GRUB password prompt every time | `set superusers` present with no `--unrestricted` entry | `--unrestricted` must stay unconditional in `02-security.hook.chroot` |
| `mute` does nothing | `alsa-utils` missing from the image | It is in `kiosk.list.chroot`; a drifted variant image caused this once |
| Remote shutdown accepted but nothing happens | The polkit power rule is missing; the agent runs as `kiosk` | `/etc/polkit-1/rules.d/50-labkiosk-power.rules` grants exactly reboot and power-off |

---

## Disk installer

| Symptom | Root cause | Fix |
| :--- | :--- | :--- |
| `rsync: delete_file: rmdir(boot/efi) failed: Device or resource busy (16)` | The ESP was mounted at `/boot/efi` before `rsync --delete` ran | Mount only `part_root` during `rsync`; drop `--delete`; mount the ESP afterwards |
| No candidate internal drives detected | The installer printed a log line to `sys.stdout`, corrupting the JSON the agent parses | All logging goes to `file=sys.stderr`; stdout is JSON only |
| The installer offers the USB it booted from | `--list-disks` recorded `removable` but never filtered on the live medium | `live_medium_disks()` excludes it when listing *and* again before `wipefs` |
| parted aborts on the ROOT or DATA partition | Negative offsets (`-513MiB`) parsed as bundled options | Pass `--` before them |
| Legacy BIOS will not boot the installed GPT disk | No BIOS Boot Partition for GRUB to embed `core.img` | Partition 1: `bios_grub`, 1–2 MiB, `set 1 bios_grub on` |
| UEFI boot entry missing after a reboot | Firmware lost NVRAM boot variables | `grub-install --target=x86_64-efi --removable` also runs, creating `/boot/efi/EFI/BOOT/BOOTX64.EFI` |
| Every installed machine shares a machine ID | `/etc/machine-id` was truncated to a newline, not to empty | It must be a genuinely **empty** file — that is the marker systemd replaces |

---

## Remote control

| Symptom | Root cause | Fix |
| :--- | :--- | :--- |
| noVNC asks for a password | No heartbeat since boot, or `/tmp/labkiosk/vnc.secret` missing | Confirm enrolment; wait one telemetry cycle |
| "Enrolment failed unexpectedly" in the wizard | The agent hit an error that is not a network or input problem — most often it could not write `/etc/labkiosk/config.json` | The message now names the exception, and the wizard opens **Agent Log & Diagnostics** by itself. Read it before rebooting: the log is in RAM |
| Need the agent log on a real workstation | It has no terminal, and `file://` is blocked | Setup wizard → **Agent Log & Diagnostics** (administrator password once installed) |
| The school address and enrollment key are gone after a reboot, and the wizard shows no warning | `/etc/labkiosk` was an **overlay** on RAM rather than the data partition: `overlayroot` was configured with an `overlayroot_options=` line it never reads, so it defaulted to `recurse=1` and overlaid every fstab entry. It is mounted and writable, which is why nothing complained | Reinstall from an ISO built with `overlayroot="tmpfs:recurse=0"`. The agent now reports the filesystem type, so this state shows up as `persistentStorage: false` and an amber warning |
| The school address and enrollment key are gone after a reboot | `/etc/labkiosk` is a directory in the RAM overlay rather than the `LABKIOSK_DATA` partition, so the enrolment was never on disk. The wizard now says so in amber before you type anything, and `persistentStorage` in `GET /api/status` reports it | Reinstall from a current ISO. The boot-time repair mounts the partition when the boot has not, and refuses to fabricate a directory that would lose the next enrolment too |
| `PermissionError: [Errno 13] ... /etc/labkiosk/config.json.tmp` when enrolling | The data partition at `/etc/labkiosk` is owned by root, so the unprivileged agent cannot write there. Disks written by an older installer show this | Reinstall from a current ISO: the installer verifies the kiosk user can write to the partition, and `labkiosk-data-permissions.service` corrects the ownership at every boot. The error text names the owner, mode and the agent's uid |
| "Failed to connect to server" | Tunnel not running, or DNS not pointing at Cloudflare | `systemctl status cloudflared-kiosk`; confirm `/etc/cloudflared/config.yml` |
| **Remote Control** disabled | No `remote_host` reported and no `TUNNEL_DOMAIN` set | Set `TUNNEL_DOMAIN` in the dashboard, or provision a tunnel |
| Black or sluggish remote screen | Bandwidth or thin-client CPU | Check hardware acceleration in firmware; noVNC adapts to latency |
| The viewer is reachable by anyone | No Cloudflare Access policy in front of the tunnel hostname | Add one before the first tunnel goes live. → [Remote Control](Remote-Control#cloudflare-access-is-mandatory) |

---

## ISO build

| Symptom | Root cause | Fix |
| :--- | :--- | :--- |
| Build dies in the chroot stage | A rootless engine forbids `mknod` even under `--privileged` | Make the engine rootful: `podman machine set --rootful`. Verify with the `mknod` one-liner in [Building the ISO](Building-the-ISO#the-engine-must-be-rootful) |
| Your changes have no effect on the ISO | A stale or pulled builder image was used; the source is copied **into** it | `docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder` first |
| Enormous build context, or a resurrected `quiet loglevel=3` | `.dockerignore` missing, dragging in `chroot/`, `cache/`, old ISOs, and a stale `config/binary` | Keep `.dockerignore` intact |
| Build fails on a pin | A pinned checksum or hash is wrong | Fix the value. **Never invent one to make the build go green** |
| A shell hook dies with `$'\r': command not found` | The file was written or checked out with CRLF | `.gitattributes` pins these to `eol=lf`. Never write them with a tool that translates newlines — Python's `Path.write_text` does, on Windows |
| `__pycache__` directories appear inside `includes.chroot` | `py_compile` ran without `PYTHONPYCACHEPREFIX` | Always set `PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc` — live-build copies whatever is on disk into the ISO |

---

## Simulator

| Symptom | Root cause | Fix |
| :--- | :--- | :--- |
| `Running as root without --no-sandbox is not supported` | The container was started as root instead of as its `kiosk` user | Run it the documented way (`docker compose up`); the entrypoint falls back to `--no-sandbox` only for uid 0, and never in the real image |
| `Check failed: sys_chroot("/proc/self/fdinfo/")`, black screen in the simulator | The container lacks `SYS_CHROOT`, which Chromium's sandbox needs | Keep `cap_add: [SYS_CHROOT]` from `docker-compose.yml` |
| `chrome_crashpad_handler: --database is required`, black screen | `$HOME` is not writable (read-only root filesystem) | The entrypoint moves the browser's home to `/tmp`; check that `/tmp` is a writable tmpfs |
| Your agent or extension edits do nothing | A pulled image runs `main`'s baked-in client source | `docker compose up -d --build`, or `docker cp` the files in |
| Extension changes do not appear after a restart | MV3 extensions are parsed at browser launch | Restart Chromium, not the agent |
| Cannot reach the wizard from the host browser | The agent's API is loopback-only, by design | Drive it from the noVNC screen |

---

## Diagnostic commands

```bash
# Worker
pnpm --prefix cloudflare-control run typecheck
pnpm --prefix cloudflare-control test

# Client syntax
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
python3 distro-builder/tools/generate-chromium-policy.py --check

# Simulator
docker exec labkiosk-client-01 tail -n 50 /tmp/lab-agent.log
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/screen.png
docker cp labkiosk-client-01:/tmp/screen.png .

# On a real workstation
systemctl status cloudflared-kiosk
cat /tmp/lab-agent.log
cat /etc/chromium/policies/managed/policies.json
```

---

## Still stuck

1. Read the agent log — it is the single most informative artefact on the client side.
2. Take a screenshot. A log line proving the agent ran does not prove the student saw anything.
3. Check the school's audit log for what actually changed and who changed it.
4. Search existing [issues](https://github.com/akbhoi/labkiosk/issues), then open one with the ISO or worker version, the platform, and the exact error.

**Do not open a public issue for a security vulnerability.** → [Security Model](Security-Model#reporting-a-vulnerability)
