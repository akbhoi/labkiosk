# Client Agent

`distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py` — a single-file Python 3 daemon, standard library only, that is the workstation's entire relationship with the control plane.

It has three jobs: serve the local setup wizard, run the telemetry heartbeat, and execute teacher commands.

---

## How it runs

The agent is **not** a systemd service. It needs the kiosk user's live X session for `scrot` and `xdotool`, so it is started from `/etc/openbox/autostart` inside a supervisor loop:

```bash
while true; do
  python3 /opt/labkiosk/agent/agent.py
  sleep 2
done
```

If it ever exits, it is back within about two seconds, and the restart is written to `/tmp/lab-agent.log`. That log lives in the RAM overlay and is gone at power-off.

```bash
# In the simulator
docker exec labkiosk-client-01 tail -n 50 /tmp/lab-agent.log
```

---

## Configuration

`/etc/labkiosk/config.json`, mode `0600`, written at enrolment:

```json
{
  "deviceToken": "…",
  "workerUrl": "https://oakridge.labkiosk.example.edu",
  "targetUrl": "https://oakridge.labkiosk.example.edu",
  "clientId": "PC-01",
  "clientNum": 1
}
```

**Where that file actually lives matters.** On live media it is in the RAM overlay and disappears at power-off — correct, because the workstation is meant to be installed rather than run from USB permanently. On an installed disk, `/etc/labkiosk` is a mount point for the `LABKIOSK_DATA` partition created by `labkiosk-install`, which is what makes a post-install enrolment persist. Without that partition, `overlayroot="tmpfs"` would discard the token on the next reboot.

Environment overrides, useful in the simulator:

| Variable | Purpose |
| :--- | :--- |
| `WORKER_URL` | Control plane base URL |
| `LABKIOSK_DOMAIN` | Base platform domain shown in the wizard |
| `LABKIOSK_REMOTE_HOST` | Tunnel hostname to report, when not read from `cloudflared` config |

---

## The telemetry loop

Every three seconds, `post_telemetry()` sends the workstation's state and receives everything it needs back. → [REST API Reference](REST-API-Reference#post-apitelemetry) for the exact payload.

```text
         +-----------------------------------------------+
         |  capture_thumbnail_base64()   scrot -t 20 -q 35 |
         |  read_vnc_password()          /tmp/labkiosk/…   |
         |  detect_remote_host()         cloudflared cfg   |
         +-----------------------------------------------+
                              |
                     POST /api/telemetry
                     Authorization: Bearer …
                              |
                              v
         +-----------------------------------------------+
         |  commands[]      -> execute_command()          |
         |  whitelist[]     -> sync_chromium_policies()   |
         |  targetUrl       -> navigate_to()              |
         |  broadcastUrl    -> navigate_to(url, epoch)    |
         +-----------------------------------------------+
```

**Failure handling.** A failed heartbeat backs off exponentially up to `MAX_BACKOFF_SECONDS` (60), so a lab that loses its uplink does not hammer the edge, and recovers promptly when the link returns.

**Thumbnails.** Captured with `scrot -t 20 -q 35` — there is **no PIL/Pillow dependency**; the agent is standard library plus `scrot`. A frame whose base64 payload exceeds `MAX_THUMBNAIL_BYTES` (256 KB) is dropped rather than sent, so an oversized capture never costs the school's uplink or delays the loop. The heartbeat still lands; only that one frame is missing.

---

## Command execution

`execute_command()` handles exactly seven actions. Anything else is logged and ignored.

| Action | Implementation |
| :--- | :--- |
| `lock` | Sets local lock state and message; the extension raises the curtain on its next poll |
| `unlock` | Clears lock state |
| `navigate` | Validates with `safe_navigable_url()`, then drives the browser |
| `reload` | Reloads the current page |
| `reboot` | `systemctl reboot` via logind |
| `shutdown` | Powers off via logind |
| `mute` | Mutes output through `alsa-utils` |

`reboot` and `shutdown` work because `/etc/polkit-1/rules.d/50-labkiosk-power.rules` grants the `kiosk` user exactly those two logind actions and nothing else. The agent runs as `kiosk`; without that rule the command would be accepted and then silently do nothing.

`navigate` never takes a URL on faith. `safe_navigable_url()` accepts only `http:` and `https:`, because the value ends up in `window.location` — a `javascript:` or `file:` URL arriving from a compromised control plane would otherwise execute in the page.

---

## Chromium policy synchronisation

`sync_chromium_policies(new_whitelist)` merges the school's effective allowlist into `/etc/chromium/policies/managed/policies.json`.

The static half of that policy is declared exactly once, in `/usr/share/labkiosk/chromium-policy-base.json`. Two consumers read it and **neither may carry its own copy of those keys**:

- `config/hooks/live/01-lockdown.hook.chroot`, which generates the boot-time policy at build time;
- `sync_chromium_policies()`, which regenerates it on every allowlist change.

When the same keys were declared twice, anything added to one and not the other silently vanished the moment a workstation enrolled. Only three keys are per-workstation and overlaid by the consumers: `HomepageLocation`, `NewTabPageLocation`, and `URLAllowlist`.

```bash
# CI check: the committed generated policy must match its base
python3 distro-builder/tools/generate-chromium-policy.py --check
```

Never hand-edit the generated `etc/chromium/policies/managed/policies.json`.

**Chromium reads managed policy only at startup.** So after writing a new policy, the agent sets `pendingBrowserRestart` and restarts the browser after the next sync. Without that, a freshly enrolled kiosk sits on a "This page is blocked" screen with a perfectly correct policy on disk.

→ [Kiosk Hardening](Kiosk-Hardening#layer-4--chromium-managed-policy)

---

## The loopback API

A `ThreadingHTTPServer` bound strictly to **`127.0.0.1:8888`**. Threaded deliberately: a slow call such as the disk scan must not stall the once-a-second status poll that drives the lock curtain.

Every request must pass two checks, and either failing returns `403`:

- `_is_expected_host()` — the `Host` header is a loopback name.
- `_is_local_caller()` — the `Origin` header, when present, is `127.0.0.1` or `localhost`.

That is what keeps a visited web page from reaching the installer.

| Endpoint | Method | Notes |
| :--- | :--- | :--- |
| `/setup` | GET | Serves the wizard. `403` once enrolled. |
| `/api/status` | GET | Local state for the wizard and the extension |
| `/api/install/disks` | GET | `[]` when not a live session |
| `/api/install/status` | GET | Progress percentage |
| `/api/install` | POST | `400` when already installed on an internal drive |
| `/api/reboot` | POST | |
| `/api/setup` | POST | `409` once already enrolled |

Input is re-validated here rather than trusted from the caller, because `/etc/sudoers.d/50-labkiosk-install` lets the `kiosk` user run the installer directly — the agent is not the only possible caller, so it is not a trust boundary.

| Pattern | Accepts |
| :--- | :--- |
| `CLIENT_ID_PATTERN` | `^[A-Z0-9][A-Z0-9_-]{0,62}$` |
| `TARGET_DISK_PATTERN` | `^/dev/(sd[a-z]\|vd[a-z]\|nvme[0-9]+n[0-9]+\|mmcblk[0-9]+)$` |
| `GRUB_PBKDF2_PATTERN` | `^grub\.pbkdf2\.sha512\.[0-9]+\.[0-9A-Fa-f]+\.[0-9A-Fa-f]+$` |
| `HOSTNAME_PATTERN` | Standard DNS label syntax |

→ [REST API Reference](REST-API-Reference#the-client-agents-loopback-api)

---

## Session awareness

`is_live_session()` decides whether the machine booted from removable media or from an installed disk:

| Signal | Meaning |
| :--- | :--- |
| `/etc/labkiosk-installed` exists | Installed drive |
| `/run/live` exists, or `boot=live` in `/proc/cmdline` | Live installer |

This drives two behaviours:

1. **Backend lockout.** `/api/install/disks` returns `[]` and `POST /api/install` returns `400 System is already installed on an internal drive`, so a misdirected click cannot repartition the running system.
2. **Wizard shape.** On live media the wizard shows both tabs — *Connect & Enroll* and *Install to Hard Disk* — with the badge `LIVE INSTALLER & SETUP`. On an installed disk it should hide the tabs and present the enrolment form alone with the badge `INSTALLED WORKSTATION ENROLLMENT`.

> **Known issue.** `/api/status` currently returns `"isLive": True` as a literal rather than the computed `live` value (`agent.py`, in the `/api/status` handler), while `isInstalled` is computed correctly. Because `wizard.html` branches on `data.isLive`, an **installed** workstation still shows the installer tab. The backend lockout above still holds, so the install itself is refused with `400` — the defect is cosmetic, not destructive, but it contradicts the documented Rule 4 behaviour.

---

## Enrolment

`enroll()` posts to `POST /api/devices/enroll` on the control plane and, on success, writes the config file, syncs the Chromium policy, and flags a browser restart. `validate_worker_url()` and `probe_worker_url()` check the target before anything is stored, so a typo in the subdomain fails loudly at the wizard instead of producing a workstation that silently never checks in.

Re-enrolment is refused with `409` while a token is present. To move a workstation to another school, decommission it from the teacher dashboard (`POST /api/clients/remove`) and reboot — on live media the config is gone with the RAM overlay; on an installed disk, clear `/etc/labkiosk/config.json`.

---

## Syntax check

```bash
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
```

`PYTHONPYCACHEPREFIX` is not optional. Without it `py_compile` writes `__pycache__` directories *inside* `config/includes.chroot`, and live-build copies whatever is on disk straight into the ISO — shipping bytecode built for the wrong interpreter into the image.

→ [Browser Extension](Browser-Extension) · [Disk Installer](Disk-Installer) · [Workstation Simulator](Workstation-Simulator)
