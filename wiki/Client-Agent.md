# Client Agent

`distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py` — a single-file Python 3 daemon, standard library only, that is the workstation's entire relationship with the control plane.

It has three jobs: serve the local setup wizard, keep the control channel to the organization's hub open, and execute operator commands.

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

**Reading it on real hardware:** open the setup wizard (the network icon in the kiosk top bar, or `http://127.0.0.1:8888/setup`) and expand **Agent Log & Diagnostics**. On an installed workstation it asks for the administrator password first. There is no other route — the machine has no terminal, no getty and no SSH, and `file://` is blocked by the Chromium policy. `docker exec` works only for the simulator.

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

**Where that file actually lives matters.** On live media it is in the RAM overlay and disappears at power-off — correct, because the workstation is meant to be installed rather than run from USB permanently. On an installed disk, `/etc/labkiosk` is a mount point for the `LABKIOSK_DATA` partition created by `labkiosk-install` — mounted by `etc-labkiosk.mount`, which `labkiosk-data-generator` pins to the partition UUID GRUB passes as `labkiosk.data=`, never by label — which is what makes a post-install enrolment persist. Without that partition, `overlayroot="tmpfs"` would discard the token on the next reboot.

Environment overrides, useful in the simulator:

| Variable | Purpose |
| :--- | :--- |
| `WORKER_URL` | Control plane base URL |
| `LABKIOSK_DOMAIN` | Base platform domain shown in the wizard |

---

## The control channel

`telemetry_loop()` keeps one WebSocket open to the organization's OrgHub (`ControlChannel`,
`GET /api/devices/ws` with the device token). The hub pushes the configuration on connect and on
every admin change, pushes commands the moment they are dispatched, and asks for screen frames
only while an operator has this screen on view. The agent sends its status when it changes, a
frame every 3 s while asked, and `{"type":"ping"}` every 15 s — byte for byte, because the edge
answers exactly that without waking the hub. → [REST API Reference](REST-API-Reference#get-apidevicesws).

It needs Debian's `python3-websocket`. Without it, or when the server has no WebSocket route
(an older Worker, or the Node development server), or after three failed connections in a row,
the agent uses the older HTTP heartbeat for ten minutes and then tries again: `post_telemetry()`
sends the same state and receives the same updates back, every 3 seconds while a console is open
and every 15 seconds otherwise, as the reply's `heartbeatSeconds` says. It captures a thumbnail
only while the reply's `frames` says a console is showing this screen.

```text
         +-----------------------------------------------+
         |  current_status()             url, lock, num   |
         |  capture_thumbnail_base64()   only if watched   |
         |  read_vnc_password()          /tmp/labkiosk/…   |
         +-----------------------------------------------+
                              |
                 WebSocket /api/devices/ws  (or POST /api/telemetry)
                     Authorization: Bearer …
                              |
                              v  apply_control_update()
         +-----------------------------------------------+
         |  commands[]      -> execute_command()          |
         |  whitelist[]     -> sync_chromium_policies()   |
         |  targetUrl       -> navigate_to()              |
         |  broadcastUrl    -> navigate_to(url, epoch)    |
         +-----------------------------------------------+
```

**Failure handling.** A failed connection or heartbeat backs off exponentially up to `MAX_BACKOFF_SECONDS` (60), so a lab that loses its uplink does not hammer the edge, and recovers promptly when the link returns. A connection the server closed on purpose (a deploy restarts every hub) is re-opened after a random pause of up to 10 s, so a whole fleet does not return at the same instant. A close with `4001` (removed) or `4003` (organization not active), like a `401`/`403`, sends the screen to the re-enrolment form.

**Thumbnails.** Captured with `scrot -t 20 -q 35` — there is **no PIL/Pillow dependency**; the agent is standard library plus `scrot`. A frame whose base64 payload exceeds `MAX_THUMBNAIL_BYTES` (256 KB) is dropped rather than sent, so an oversized capture never costs the organization's uplink or delays the loop. The heartbeat still lands; only that one frame is missing. Over the WebSocket, no screenshot is taken at all unless an operator is watching.

**Remote Control.** A `{"type":"remote","session":…}` message on the WebSocket makes `start_remote_session()` open `GET /api/devices/remote` (device token plus `X-Labkiosk-Session`) and pipe it to x11vnc on `127.0.0.1:5900`, one session at a time. The HTTP heartbeat cannot carry that message, so an agent on the fallback cannot join. → [Remote Control](Remote-Control)

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

## Network subsystem

The agent incorporates a full network management subsystem communicating with NetworkManager via `nmcli` and system sockets.

### 1. Interface & Carrier Detection (`/api/network/interfaces`)

`get_interfaces()` scans network hardware (`nmcli -t -f DEVICE,TYPE,STATE dev status`), categorising adapters as `ethernet` or `wifi`. For ethernet devices, it reads `/sys/class/net/<dev>/carrier` to provide real-time feedback on physical cable plug state (`Connected` vs. `Unplugged`).

### 2. Wi-Fi Scanning (`/api/network/wifi/scan`)

`scan_wifi()` triggers `nmcli -t -f SSID,BSSID,SIGNAL,SECURITY,CHAN dev wifi list`, deduplicating BSSIDs by SSID name and sorting candidates by signal percentage. Networks report encryption types (e.g. WPA2/WPA3-PSK vs. Open). Hidden networks are supported via manual SSID input.

### 3. Connection Configuration (`/api/network/configure`)

`configure_network()` orchestrates NetworkManager profiles:

- **Ethernet:** Deletes stale profiles on the interface and creates `Wired Connection (<dev>)`.
- **Wi-Fi:** Configures `Wi-Fi (<ssid>)` with `802-11-wireless-security.key-mgmt wpa-psk` and PSK passphrase.
- **IPv4:**
  - `auto`: Standard DHCP client (`ipv4.method auto`, `ipv4.ignore-auto-dns no`).
  - `custom_dns`: DHCP addressing with custom nameserver override (`ipv4.method auto`, `ipv4.ignore-auto-dns yes`, `ipv4.dns "<dns>"`).
  - `manual`: Static addressing (`ipv4.method manual`, `ipv4.addresses "<ip>/<prefix>"`, `ipv4.gateway "<gw>"`, `ipv4.dns "<dns>"`).
- **IPv6:** Configurable as `auto` (SLAAC/DHCPv6), `custom_dns`, `manual`, or `disabled`.
- **Proxy:** Saves settings to `/etc/labkiosk/proxy.json`, applies proxy exports (`http_proxy`, `https_proxy`, `no_proxy`, loopback always exempt) to the agent's own environment, and regenerates `/etc/chromium/policies/managed/policies.json` with a `ProxySettings` dictionary (`ProxyMode: "fixed_servers"`, `ProxyServer: "<host>:<port>"`, `ProxyBypassList` as a comma-separated string). On installed systems the request needs the `X-LabKiosk-Admin` token from `/api/admin/verify`.

### 4. Connectivity Probing & Caching (`/api/network/test`)

`test_connectivity()` validates the connection:

- DNS resolution via `socket.getaddrinfo("cloudflare.com", 443)`.
- Direct routing reachability via socket connection to `1.1.1.1:53` and `8.8.8.8:53` (2.5s timeout).
- **5-Second TTL Cache:** Because `/api/status` is polled once a second by the browser extension, `test_connectivity(force=False)` returns cached results to avoid socket exhaustion.

### 5. Administrator Verification (`/api/admin/verify`)

Post-installation network management is locked behind `verify_admin_password()`. The digest is read from `labkiosk-password.cfg` in `/run/live/medium/boot/grub` — on an installed disk that is `boot/grub` on `LABKIOSK_ROOT`, outside every system image, which live-boot mounts there read-only; on the ISO it holds the build-time password, if one was pinned. When the file exists, the agent parses the GRUB PBKDF2 line:

```text
password_pbkdf2 <user> grub.pbkdf2.sha512.<rounds>.<salt_hex>.<hash_hex>
```

It computes `hashlib.pbkdf2_hmac("sha512", password, salt, rounds)` and checks equality in constant time.

### 6. Polkit Permissions

The agent runs as unprivileged user `kiosk`. NetworkManager commands succeed because `/etc/polkit-1/rules.d/50-labkiosk-network.rules` explicitly authorizes `org.freedesktop.NetworkManager.*` for user `kiosk`.

---

## Chromium policy synchronisation

`sync_chromium_policies(new_whitelist)` merges the organization's effective allowlist into `/etc/chromium/policies/managed/policies.json`.

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
- `_is_local_caller()` — the `Origin` header, when present, is `127.0.0.1` or `localhost`, or the
  kiosk extension's own `chrome-extension://` origin. Chromium sets that one on the service
  worker's `POST` to `/api/admin/verify`, which is how the top bar's administrator modal asks
  for a token. The id is pinned by the `key` in `manifest.json`.

That is what keeps a visited web page from reaching the installer.

| Endpoint | Method | Notes |
| :--- | :--- | :--- |
| `/setup` | GET | Serves the wizard. `403` once enrolled. |
| `/api/status` | GET | Local state for the wizard and the extension, with the Secure Boot state, the hostname, `clockSynchronized` (whether a time server has set the clock since boot), and `keyboardPresent`/`touchPresent` (`input_devices_report()`, cached 5 s; `null` when unknown) |
| `/api/usage/tick` | POST | `{ host, active }` from the extension's service worker once a minute while a page is shown: the top frame's hostname and whether `chrome.idle` saw input in the last minute. Counted into the next usage report |
| `/api/install/disks` | GET | `[]` when not a live session |
| `/api/install/status` | GET | Progress percentage |
| `/api/install` | POST | `400` when already installed on an internal drive, or when `hostname` is not one lowercase DNS label |
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
| `labkiosk.installed=1` on the kernel command line (or `/etc/labkiosk-installed`, on a disk installed before the image store) | Installed drive, checked first |
| otherwise `/run/live` exists, or `boot=live` in `/proc/cmdline` | Live installer |

Both of the latter are true on an installed disk as well, because it boots its system image through live-boot; only the installed boot menu passes `labkiosk.installed=1`.

This drives two behaviours:

1. **Backend lockout.** `/api/install/disks` returns `[]` and `POST /api/install` returns `400 System is already installed on an internal drive`, so a misdirected click cannot repartition the running system.
2. **Wizard shape.** On live media the wizard shows both tabs — *Connect & Enroll* and *Install to Hard Disk* — with the badge `LIVE INSTALLER & SETUP`. On an installed disk it should hide the tabs and present the enrolment form alone with the badge `INSTALLED WORKSTATION ENROLLMENT`.

`/api/status` reports the computed value in `isLive` and `isInstalled`, and the wizard branches on it: an installed workstation shows neither the installer tab nor the network step.

It also reports **`persistentStorage`**. That is false when `/etc/labkiosk` is not the `LABKIOSK_DATA` partition — the machine can still be enrolled, and the enrolment lives in the RAM overlay and is gone at the next power-off. The wizard shows an amber warning before the form and again instead of the usual success, the enrolment reply carries `persistent` and `warning`, and the agent writes the same warning to its log at every start, because a workstation with no terminal has no other way to answer "why did it forget?".

---

## Saved language and region

An installed workstation boots a system image under a RAM overlay, so the timezone, keyboard, time server and generated locale are the image's defaults again at every boot, and an update replaces the image altogether. The image ships no `locales-all`: `apply_saved_localization()` re-applies the choice saved in `/etc/labkiosk/localization.json` on `LABKIOSK_DATA` at every start, through `labkiosk-localization`, which regenerates the locale when it is missing. A failure is logged and never stops the agent.

The clock also takes the network's own time servers. The NetworkManager dispatcher script `50-labkiosk-ntp` writes the IPv4 servers a DHCP lease names (option 42, validated) to `/run/systemd/timesyncd.conf.d/network-dhcp-<iface>.conf` and try-restarts `systemd-timesyncd`; the file is removed when the link goes down or a lease names none. A time server set in the wizard (`/etc/systemd/timesyncd.conf.d/labkiosk.conf`) sorts first, so it is tried first, and Debian's pool stays the fallback. The wizard's diagnostics line shows `Clock: Set from a time server` or `Not set from a time server yet`, from `clockSynchronized` (`/run/systemd/timesync/synchronized` exists).

---

## Boot reports

On an installed disk, `labkiosk-boot-slots check` (root, run by `labkiosk-boot-ok.service`) records what this boot did with its system image in `/run/labkiosk-update/status.json`. `boot_report_loop()` reads it — refusing a file not owned by root or over 4 KiB — and posts the outcomes worth an administrator's attention to `POST /api/devices/boot-report` with the device token: `installed`, `failed`, `rolled-back`, `fallback` and `error`. Routine boots are not sent.

A report is retried every 30 s until the control plane answers it for good (`200`, or `400`/`404`, which are not resent); the Worker drops a report it already holds. The latest outcome is kept on the workstation's row, and a failure, rollback, fallback or error is listed under Settings → **Errors & Warnings** in the admin console.

## Restart reports

An installed disk keeps its system journal on `LABKIOSK_DATA` for seven days (`labkiosk-logs.service`, root). A boot that ends without a clean shutdown — a power cut, a forced power-off, a hang the hardware watchdog restarted after 30 s, or a kernel panic (the workstation restarts 10 s after one) — is found at the next start, and the last 300 lines of its journal are saved as `/etc/labkiosk/logs/reports/<bootId>.json`. The same loop as the boot reports sends each to `POST /api/devices/restart-report` once, reading only root-owned files whose name matches the boot id inside, and lists the ones the control plane answered for good in `/etc/labkiosk/restart-reports-sent.json`. A report it could not send is sent at a later round or the next boot, until `labkiosk-logs` deletes it after seven days. The agent's own log lines also go to the journal (syslog ident `labkiosk-agent`), so a report shows what the agent was doing.

## Disk health

`labkiosk-health` (root, run by `labkiosk-health.timer` 90 s after boot and every six hours) checks the machine's own disks — not removable or USB ones: SMART through `smartctl` for SATA and NVMe, the card's wear figures in sysfs for eMMC. A disk is **failing** when its self-assessment failed, NVMe raises a critical warning or its spare is below threshold, and **warning** at 90 % or more of its rated life used, reallocated, pending or uncorrectable sectors, NVMe media errors or a pre-fail attribute past its threshold. A disk with no data (a virtual one) is `unknown` and never reported. The result goes to `/run/labkiosk-health/disks.json`, and `[HEALTH] …` lines to the journal, with the user Xorg runs as and the AppArmor labels of the agent and x11vnc.

The same loop as the boot reports reads that file (root-owned, at most 16 KiB) after each check and posts the warning and failing disks to `POST /api/devices/disk-health`. A `200`, `400` or `404` settles that check, as does `429` (too many disk reports today; the next check sends again); `409` (the workstation is not written yet), any other status and a network failure are retried next round. The Worker lists each disk once per state under Settings → **Errors & Warnings**.

## Video decoding

Chromium decodes video through VA-API when the GPU has a driver for it, and on the CPU otherwise, which a thin client notices at once. Once per agent start, after enrolment, the same loop as the boot reports runs `vainfo --display drm --device /dev/dri/renderDNNN` on each render node (at most four), names the GPU from sysfs (Intel, AMD, NVIDIA, a virtual adapter, or other, with its kernel driver) and posts what each decodes and encodes (H.264, HEVC, VP8, VP9, AV1, MPEG-2, VC-1, JPEG) to `POST /api/devices/video-decoding`. A machine with no render node, a GPU without a VA-API driver, or a `vainfo` that fails says so in `problem`. `200`, `400` and `404` settle it; `409` (the workstation is not written yet) and network failures are retried every 30 s. The log line `Hardware video decoding: av1, h264, hevc, vp9.` (or `none, Chromium decodes on the CPU.`) says the same on the workstation.

The admin console shows the result on the workstation's card: `Video: GPU · H.264, HEVC, VP9, AV1`, or `Video: CPU · NVIDIA graphics` or `Video: CPU only` in the warning colour. `vainfo` reports what the driver offers; Chromium uses it for the codecs and resolutions its own decoder supports, so a codec listed here is decoded in hardware in practice but not guaranteed for every stream.

---

## Hardware

Once per agent start, after enrolment, the same loop as the boot reports reads what the machine is and posts it to `POST /api/devices/hardware`: the maker and model from DMI (`/sys/devices/virtual/dmi/id/`; Lenovo names the model in `product_version`), the CPU model from `/proc/cpuinfo`, the core count, memory from `/proc/meminfo`, UEFI or BIOS boot, whether a keyboard and a touchscreen are attached (`input_devices_report()`, `null` when it cannot tell), and the MAC addresses of up to 8 physical wired adapters (for Wake-on-LAN). Placeholder firmware names such as "To be filled by O.E.M." are sent but treated as unknown by the control plane. `200`, `400` and `404` settle it; `409` and network failures are retried every 30 s. The log line `Hardware: LENOVO ThinkCentre M720q, 6 cores, 7851 MB, UEFI, 1 wired adapters.` says the same on the workstation.

## Usage reports

`UsageCounter` adds up, per local calendar day, how long the workstation was switched on (credited every minute by `usage_loop`, at most 2 minutes at a time so a suspend or a stopped clock does not count), how long it was in use (the extension's `/api/usage/tick`: someone used the keyboard, mouse or touchscreen in the last minute; capped at the time switched on), sessions (each agent start and each `clear-session`), and, while the organization records sites (`usageSites` in the configuration), seconds in use and visits per hostname (at most 100 a day; IP addresses and `localhost` are never recorded). Every 15 minutes `usage_loop` sends what has accumulated to `POST /api/devices/usage` and starts again from zero; a network failure or any status but `200` and `400` puts the report back to be sent with the next one, and days more than 7 days old are dropped. Nothing is sent before enrolment. The counts live in memory, so at most 15 minutes are lost when the workstation is switched off at the button.

## Enrolment

`enroll()` posts to `POST /api/devices/enroll` on the control plane and, on success, writes the config file, syncs the Chromium policy, and flags a browser restart. `validate_worker_url()` and `probe_worker_url()` check the target before anything is stored, so a typo in the subdomain fails loudly at the wizard instead of producing a workstation that silently never checks in.

The server must be `https`. Plain `http` is accepted only for a local test server: `localhost`, a loopback address, the container gateways (`host.docker.internal`, `host.containers.internal`, `*.internal`, `*.local`), or a private IPv4 literal in `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16` (the set the control plane treats as a dev host). That covers a test VM reaching `pnpm dev` on its host, e.g. `http://172.31.64.1:8787` over the Hyper-V Default Switch. Public, link-local (`169.254.x.x`) and IPv6 addresses, and any hostname, still need `https`, because the device token travels in every heartbeat.

Re-enrolment is refused with `409` while a token is present. To move a workstation to another organization, decommission it from the admin console (`POST /api/clients/remove`): the next refused heartbeat sends the screen to the wizard's re-enrolment form (`/setup#reenrol`), where registering with the new organization's key needs the administrator password on an installed disk. On live media a reboot also forgets the old configuration with the RAM overlay.

---

## Syntax check

```bash
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
```

`PYTHONPYCACHEPREFIX` is not optional. Without it `py_compile` writes `__pycache__` directories *inside* `config/includes.chroot`, and live-build copies whatever is on disk straight into the ISO — shipping bytecode built for the wrong interpreter into the image.

→ [Browser Extension](Browser-Extension) · [Disk Installer](Disk-Installer) · [Workstation Simulator](Workstation-Simulator)
