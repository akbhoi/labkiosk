---
name: labkiosk-client
description: Lab Kiosk workstation software — the Python agent (opt/labkiosk/agent/agent.py) and its loopback API, the MV3 browser extension (content.js top bar and lock curtain, background.js), the setup wizard (wizard.html), interface translations (i18n catalogs), the Language & Region helper (labkiosk-localization), network configuration, keyboard lockdown and clear-session. Use when changing any of these; use labkiosk-distro for the ISO build and installer.
---

# Lab Kiosk — agent, extension, wizard

Paths are under `distro-builder/config/includes.chroot/`. Authoritative detail:
`distro-builder/AGENTS.md` Rules 1e–1i and 4–7.

## Agent (`opt/labkiosk/agent/agent.py`, standard library only)

- API binds **`127.0.0.1:8888` only**. Mutating endpoints (`/api/install`, `/api/reboot`,
  `/api/setup`, `/api/network/configure`, `/api/admin/verify`, localization) check
  `_is_local_caller()`: loopback origins plus exactly `KIOSK_EXTENSION_ORIGIN`
  (`chrome-extension://<pinned id>`). Match the literal id, never the scheme.
- **Admin gate** on installed disks: `/api/admin/verify` checks the GRUB PBKDF2 hash and issues a
  10-minute token (`X-LabKiosk-Admin`; 5 failures → 60 s lock); network, reboot and `/api/log`
  require it. A password file that cannot be parsed fails closed.
- Endpoints: `/setup`, `/blocked`, `/api/status` (`isLive`, `isInstalled`, `isOnline`,
  `persistentStorage`, `reloadEpoch`, `enrolmentRejected`, `organization`…), `/api/setup` (on an
  enrolled workstation: admin token required), `/api/install/disks`, `/api/install`, `/api/install/status`,
  `/api/reboot`, `/api/network/{status,interfaces,wifi/scan,configure,test}` (`test_connectivity()`
  caches 5 s; interfaces from `nmcli dev status`), `/api/admin/verify`, `/api/log`,
  `/api/localization/{options,configure,languages,language/download}`, `/i18n/<tag>.json`.
- `is_live_session()`: `/etc/labkiosk-installed` ⇒ installed; `/run/live` or `boot=live` ⇒ live.
  Install endpoints refuse when `not is_live_session()` (`/api/install/disks` returns `[]`).
- **Worker URL** (`validate_worker_url()`): `https`, or plain `http` only to loopback, container
  gateways, `*.internal`/`*.local`, or a private IPv4 literal (`is_private_ip_literal()`:
  `10/8`, `172.16/12`, `192.168/16`). Never widen to hostnames or public IPs — the device token
  rides every connection.
- **Control channel** (`telemetry_loop()`): a WebSocket to the organization's hub
  (`ControlChannel`, `open_control_channel()`; `wss://` beside `https://`) when `python3-websocket`
  is installed, the 3-second HTTP heartbeat (`http_heartbeat()`) otherwise and for 10 minutes after
  the server has no WebSocket route or three connects fail. One thread, receives that wait
  0.5 s, then sends what is due: the ping (`WEBSOCKET_PING`, byte-identical to the hub's
  auto-response — never `json.dumps` it), a status when it changed, a frame only while the hub says
  someone watches. Every reply goes through `apply_control_update()`. `heartbeat_wakeup` (set by a
  new enrolment) closes the socket so the new token connects at once. The proxy from
  `load_proxy_config()` is passed to websocket-client explicitly. Contracts: `labkiosk-core` §1.
- Enrolment reply names the organization via `organization_name()` (`organizationName`, falling
  back to the deprecated `schoolName`). Persistence is reported, not assumed:
  `enrolment_is_persistent()` checks the **filesystem type** at `/etc/labkiosk`.
- Commands: `execute_command()` implements `lock, unlock, navigate, reload, reboot, shutdown,
  clear-session, mute`. `reload` bumps `reloadEpoch` (never `xdotool`). `clear-session` calls
  `restart_browser()`; the Openbox autostart and `docker-test/entrypoint.sh` watchdogs `rm -rf`
  the profile and cache before every relaunch — keep that wipe there (deleting from the agent races
  Chromium's writes); a test pins both launchers.
- Network: `configure_network()` validates every field before one `nmcli connection add`; an empty
  Wi-Fi password keeps the saved one; `profile` in `/api/network/status` pre-fills the wizard;
  proxy lives only in `/etc/labkiosk/proxy.json`. Keyfiles persist on `LABKIOSK_DATA` via bind mount.
- Log is trimmed in place at 1 MB (never renamed: autostart holds it with `>>`).
- **Validation regexes anchor with `\Z`, never `$`** — and in a raw string it is `\Z`, never
  `\\Z` (that demands a literal backslash; it once rejected every language tag and broke installs).
  A test scans the client scripts for it.

## Language & Region (`usr/local/sbin/labkiosk-localization`)

The only program the agent may run through sudo (`/etc/sudoers.d/51-labkiosk-localization`); it
**re-validates every argument** (zone against
zoneinfo + `zone1970.tab`, locale against `/usr/share/i18n/SUPPORTED`, keymap against X11 rules,
language tag against `UI_LANGUAGE_PATTERN`, which must equal the agent's). A locale has three
spellings (`en_IN`, `en_IN.UTF-8`, `en_IN.utf8`): compare with `canonical_locale()`/`locale_key()`,
never `==`. Missing `timedatectl`/`localectl`/`hwclock`/`setxkbmap` means "declined", never a crash
(`run(..., check=False)`). `--root <dir>` applies to the installer's target.

Wizard steps (live): Language & Region → Network Setup → Install or Preview. An installed
workstation opens on enrolment; `#network` / `#locale` (behind the admin modal) are the way back.
Language & Region comes first so NTP is reachable once the network is up; it opens on **"Select…"**
for continent/country/zone — only a *saved* zone is pre-selected, a single-zone country
auto-selects, Continue refuses an empty zone.

## Interface text (i18n)

- Every visible string carries `data-i18n="<key>"` **and** its English text; script strings use
  `t(key, english)`; catalogs are applied with `textContent`. `_meta.direction: "rtl"` flips layout.
- `en-US.json` ships in the image; others go to `/etc/labkiosk/i18n` or come from the Worker.
- **Every referenced key must exist in `en-US.json`** (tested). Renaming a key orphans every
  existing translation silently — change English values, not keys (six legacy keys keep old names).

## Extension (`opt/labkiosk/extension/`)

**Never strand a workstation** (`distro-builder/AGENTS.md` Rule 6b): a 401/403 heartbeat or
handshake, or a hub close `4001`/`4003`, calls `mark_enrolment_rejected()` (screen → `/setup#reenrol`, browser restarted once); an enrolled
workstation re-enrols through `/api/setup` with the admin token; `background.js` replaces
`chrome-error://` pages — where no extension runs — with `/blocked` (one automatic retry) or
`/setup#offline` (only when the agent says offline, or a dead site would loop). Before telling
anyone affected workstations "just re-enrol", see that flow work in the simulator.

Top-level navigation only (never iframes). `content.js` builds the bar (incl. `#btn-network`),
curtain and admin modal in a Shadow DOM and never calls the agent — only `background.js` does
(it holds `host_permissions`, answers `labkiosk:verify-admin` / `labkiosk:network-status`, and owns
the once-per-session `labkiosk:intro-peek` reveal). It auto-hides the bar (`mouseY <= 12`), preserves `u.search` in `normalizeUrl()`, redirects to `/setup#offline`
after 6 s offline (never from a locked screen). Keyboard: blocks Ctrl/Alt/Meta combos in the capture
phase in all frames but **allows AltGr printable characters and dead keys**; clipboard keys only on
the wizard origin. Layers below it: Openbox `rc.xml` at `~/.config/openbox` **and** `/etc/xdg/openbox`,
and `labkiosk-lock-keys` (`xkbcomp`: F keys, Super, menu, Print, Pause, Scroll Lock, Insert and
`XF86*` become `NoSymbol`; judge a key by its first symbol, strip higher levels individually so
`KP_Multiply` keeps typing; re-run after any `setxkbmap`).

## Verify

```bash
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-localization
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover -s distro-builder/tests -t distro-builder/tests
```

`wizard.html`'s inline scripts are not covered by `node --check`: extract each `<script>` and check
it (an unescaped apostrophe in a single-quoted fallback string once broke the whole wizard). Add a
test for every new validator — `distro-builder/tests/test_client.py` is the client's only automated
check. Then see it on screen: `labkiosk-simulator`.
