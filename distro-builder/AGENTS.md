# LabKiosk Distro Builder & Client OS — AI Agent Codex

> **Scope:** This document is the authoritative architectural specification and coding standard for the **Debian 12 Live Kiosk Operating System**, containerized ISO build pipeline, local Python agent daemon, automated hard disk installer, and Chromium Manifest V3 extension.
> For the Cloudflare edge SaaS control plane, refer to [`cloudflare-control/AGENTS.md`](../cloudflare-control/AGENTS.md). For master cross-cutting contracts, refer to the root [`AGENTS.md`](../AGENTS.md).

---

## 1. System Architecture Map

```text
distro-builder/
├── Dockerfile                          # Containerized cross-platform live-build environment
├── docker-build.sh                     # The Dockerfile's CMD: clean, config, build, checksum
├── build-iso.sh                        # Native Debian/WSL2 build script
├── auto/                               # live-build automation scripts
│   ├── config                          # Kernel cmdline, bootappend, distributions, package lists
│   ├── build                           # Invokes lb build
│   └── clean                           # Purges caches and builds
├── config/
│   ├── bootloaders/                    # ISOLINUX (BIOS) and GRUB EFI (UEFI) configs & graphics
│   │   ├── isolinux/live.cfg.in        # BIOS boot menu card (LabKiosk branding, failsafe)
│   │   └── grub-pc/grub.cfg            # UEFI boot menu card
│   ├── package-lists/
│   │   └── kiosk.list.chroot           # Minimal package manifest (Xorg, Openbox, Chromium, rsync, parted, efibootmgr)
│   ├── hooks/live/
│   │   ├── 01-lockdown.hook.chroot     # Kiosk user, autologin, PAM, polkit, Xorg setuid, sudoers
│   │   └── 02-security.hook.chroot     # sysctl hardening, limits, GRUB password enforcement
│   └── includes.chroot/                # Root filesystem overlay directly injected into the OS image
│       ├── etc/
│       │   ├── chromium/policies/      # Managed enterprise policies (URLBlocklist, URLAllowlist)
│       │   ├── openbox/                # Empty keybindings (rc.xml) & autostart script
│       │   ├── overlayroot.conf        # RAM overlay (overlayroot="tmpfs", recurse=0)
│       │   └── systemd/system/         # cloudflared-kiosk.service only; nodm is configured
│       │                               #   through /etc/default/nodm in 01-lockdown.hook.chroot,
│       │                               #   and the agent is started by the Openbox autostart
│       ├── opt/labkiosk/
│       │   ├── setup/wizard.html       # Setup & Enrollment Wizard GUI (HTML/JS)
│       │   ├── extension/              # Manifest V3: content.js (top bar & curtain) +
│       │   │                           #   background.js (service worker; sole loopback caller)
│       │   └── agent/agent.py          # Python 3 telemetry daemon & local loopback API
│       ├── usr/local/bin/
│       │   └── labkiosk-install        # Automated Python disk installer (GPT, ESP, ext4, dual GRUB)
│       └── usr/share/labkiosk/         # chromium-policy-base.json (the single policy declaration)
│                                       #   plus the cloudflared.pin, grub.pin & novnc.pin build
│                                       #   pins and install-novnc.sh
└── out/                                # Generated ISO & SHA-256 artifacts
```

---

## 2. Invariant Rules for Client Distro & Installer

### Rule 1: 100% RAM Overlay Protection (`overlayroot="tmpfs"`)
- The client OS runs as an **immutable system with all writes diverted to RAM**
  (`overlayroot="tmpfs"`, on live media and internal drives alike). `toram` — copying the entire
  image into RAM up front — is an **additional, opt-in boot menu entry**, not what the default
  entry does; `auto/config`'s `--bootappend-live` contains no `toram`.
- **The single exception on an installed disk is `/etc/labkiosk`**, which the installer mounts from
  the `LABKIOSK_DATA` partition so that a post-install enrolment survives a reboot. Everything
  else, including `/etc/machine-id`, is regenerated every boot.
- That partition **must be owned by the `kiosk` user**: the agent runs unprivileged and writes
  `config.json` there at enrolment. Three things keep it that way, and all three should stay:
  the installer chowns the mounted partition and then *proves* the kiosk user can write to it
  (the install fails loudly otherwise); `labkiosk-data-permissions.service` re-checks it at every
  boot, before `nodm`; and `save_config()` reports the directory's owner, mode and the agent's own
  uid when a write fails, because the workstation has no shell to investigate from.
  `system-connections` inside it stays root-only — those keyfiles hold Wi-Fi passphrases.
- **A directory at `/etc/labkiosk` is not a substitute for the partition, and nothing may pretend
  otherwise.** The fstab entry is `nofail`, which means systemd does not order the boot behind it,
  so that path can still be unmounted when the repair service runs. Creating a writable directory
  there is the worst available outcome: the agent enrols into the RAM overlay and the school's
  workstation forgets everything at the next power-off, with nothing on screen to say so. The
  service therefore mounts the partition (`After=…etc-labkiosk.mount`, then `mount /etc/labkiosk`)
  and, when it cannot, leaves the path exactly as it found it. `enrolment_is_persistent()` in the
  agent answers the same question for the UI: `persistentStorage` in `/api/status` and `persistent`
  in the enrolment reply, both of which the wizard renders as an amber warning rather than a
  silent success.
- Thin-client SSDs and flash storage (as small as 12 GB, with limited write cycles) are protected from flash degradation.
- The underlying root filesystem **must remain mounted read-only (`ro`)**.
- All dynamic filesystem writes (browser cache, agent logs, temporary downloads, student sessions) divert strictly to `tmpfs` in RAM.
- On reboot or power loss, 100% of runtime changes and student artifacts vanish instantly.

### Rule 1a: `recurse=0` Belongs Inside the `overlayroot` Value
- `overlayroot`'s initramfs script reads exactly two variables from
  `/etc/overlayroot.conf`: **`overlayroot`** and **`overlayroot_cfgdisk`**
  (`VARIABLES=` at the top of `/usr/share/initramfs-tools/scripts/init-bottom/overlayroot`).
  An `overlayroot_options="recurse=0"` line is therefore read by nothing.
- That matters more than it looks. With `recurse` left at its default of `1`, the script's
  `overlayrootify_fstab()` rewrites **every** `/etc/fstab` entry: the real filesystem is remounted
  read-only under `/media/root-ro`, and the original mount point becomes an overlay whose upper
  layer is the RAM tmpfs. `LABKIOSK_DATA` included. The workstation then enrols into RAM and
  forgets it at the next power-off, while `/etc/labkiosk` still passes every "is it mounted?"
  test — which is exactly how this survived for so long.
- The only correct spelling is **`overlayroot="tmpfs:recurse=0"`**, and the same applies to the
  kernel command line (`auto/config`, both bootloader menus). `mounted_fstype()` in the agent
  checks the filesystem *type* at `/etc/labkiosk` rather than merely that something is mounted
  there, so a regression shows up as `persistentStorage: false` instead of silent data loss.

### Rule 1d: The Timezone Is Set Twice, On Purpose
- **`Asia/Kolkata` (IST) is the build default, not the only answer.** The wizard's Language &
  Region step is what a school actually uses, and it writes the chosen zone at installation time;
  the build default is only what an unconfigured image comes up with.
- Everything runs on that default until then: the live session, an installed workstation, the
  workstation simulator and the ISO builder image.
- An installed disk takes it from `/etc/localtime` and `/etc/timezone` as built, written by
  `01-lockdown.hook.chroot` — live-config never runs there, because the installed system boots
  without `boot=live`.
- A **live** session does run live-config, and its `0070-tzdata` component rewrites `/etc/timezone`
  on every boot, defaulting to `Etc/UTC` when nothing on the kernel command line says otherwise.
  That is why `timezone=Asia/Kolkata` is on `--bootappend-live`, on `--bootappend-live-failsafe`,
  and on the hardcoded failsafe entry in all three boot menus (`isolinux`, `syslinux`, `grub-pc`),
  which do not inherit `@APPEND_LIVE@`.
- Change one and change the other, or a workstation and the USB stick it was installed from will
  disagree about the time. `systemd-timesyncd` keeps the clock itself correct.

### Rule 1b: The Boot-Menu Password Is Per-Installation, and Booting Never Prompts
- A hash compiled into the ISO would be one password shared by every customer that image was
  shipped to: unrotatable in the field, and permanent in git history. So `grub.pin` stays empty
  in this repository and the password is applied at **installation** time
  (`labkiosk-install --grub-password-hash`), or per customer at build time via
  `LABKIOSK_GRUB_PBKDF2`.
- **`--unrestricted` must stay unconditional.** `02-security.hook.chroot` marks every generated
  menu entry `--unrestricted` whether or not a password is pinned. It is a no-op without
  `superusers`, but because the password now usually arrives at install time, making it
  conditional again would give an installed disk `set superusers` with no unrestricted entry —
  and every workstation would stop at a password prompt on every boot instead of coming up into
  the kiosk.

### Rule 1c: Only What the Package List Names
- `auto/config` passes `--apt-recommends false --firmware-chroot false --firmware-binary false`. Anything the image needs is listed by name in `config/package-lists/kiosk.list.chroot`, including packages that are merely *recommended* elsewhere (`systemd-timesyncd`, `shim-signed`, `grub-efi-amd64-signed`, `xserver-xorg-video-intel`/`-qxl`) and every `firmware-*`/microcode package. Re-enabling either default puts ~1 GB of unused packages back into the ISO.
- The noVNC web client comes from the release pinned in `usr/share/labkiosk/novnc.pin`, installed by `install-novnc.sh` in both the ISO hook and the simulator Dockerfile. Never add Debian's `novnc` package: it depends on Node.js and OpenStack libraries.
- Do not reintroduce `x11-xserver-utils` for `xset`: screen blanking is disabled in `10-kiosk-lockdown.conf`.
- **`live-tools` is not optional.** It ships `/lib/systemd/system-shutdown/live-tools.shutdown`, the
  "Please remove the live-medium ... press ENTER" prompt at the end of a live session. It is only a
  *Recommends* of `live-boot`, so switching recommends off silently removed it, and a machine that
  had just been installed rebooted straight back into the installer ISO. `eject` goes with it.
- `01-lockdown.hook.chroot` adds `/lib/systemd/system-shutdown/labkiosk-medium.shutdown` for the one
  case `live-tools` skips: a USB stick, which it refuses to eject because that needs a cold reboot.
  Both scripts exit immediately unless `boot=live` is on the command line, so a teacher's remote
  reboot of an installed workstation never waits for a keypress.

### Rule 1e: Language & Region Comes Before the Network, and Owns One Privileged Program
- The wizard's **first** step is Language & Region, ahead of the network on purpose: NTP is only
  reachable once the network exists, so a workstation installed in a school with no DHCP would
  otherwise spend its first session at the wrong date — and TLS, enrolment and every lesson site
  care about that. The step therefore also offers the clock by hand.
- **Nothing in that step is a list this project maintains.** Continents, countries and zones come
  from tzdata's own `zone1970.tab` and `iso3166.tab`, locales from `/usr/share/i18n/SUPPORTED`
  (the `locales` package, ~21 MB), keyboard layouts from the X11 rules list. A hardcoded country
  list would be wrong by the next tzdata update.
- Setting a timezone, generating a locale and writing `/etc/default/keyboard` need root, and the
  agent does not run as root. `/usr/local/sbin/labkiosk-localization` is the only program it may
  run through sudo, and **it re-validates every argument against those same tables** — the caller
  is not a trust boundary, exactly as with `labkiosk-install`.
- The same program applies settings to a *target* root with `--root`, which is how the installer
  carries the choice onto the disk: `/etc/localtime`, `/etc/default/locale` and
  `/etc/default/keyboard` live on the root filesystem, not on `LABKIOSK_DATA`. Generating the
  locale there too keeps it off the RAM overlay, where it would be rebuilt at every boot.
- The choice itself is persisted in `/etc/labkiosk/localization.json`, and `apply_saved_localization()`
  re-applies it at every agent start.

### Rule 1f: Interface Text Is Translatable, and English Is in the Markup
- Every user-visible string in `wizard.html` and in the kiosk top bar carries `data-i18n="<key>"`
  **and its English text**. The runtime replaces the text only where a catalog has that key, so a
  missing, partial or broken catalog degrades to English rather than to blank buttons.
- `en-US` ships in the image at `/opt/labkiosk/i18n/en-US.json` and is the source. Other languages
  are `<tag>.json` files dropped into `/etc/labkiosk/i18n` on the data partition — no new ISO
  needed. The agent serves them from `GET /i18n/<tag>.json`, matching the tag against a pattern
  before it ever becomes a path.
- The catalog is applied with `textContent`, never `innerHTML`: a translation is data, and a school
  that pastes one in must not be able to inject markup into the wizard.
- `_meta.direction: "rtl"` flips the wizard and the bar for right-to-left languages.
- **Catalogs can also come from the control plane.** `GET /api/i18n` lists what the platform has
  and `GET /i18n/<tag>.json` serves one; both are public, because a workstation fetches its
  interface language before it is enrolled and holds no credential at that point, and the text is
  the same for every school. Only a super admin writes them (`POST /api/super/i18n`), the upload is
  sanitised on the way in, and the agent re-checks size, shape and types on the way out — neither
  side may assume the other did.
- The agent stores a downloaded catalog in `/etc/labkiosk/i18n`, so it survives the reboot and
  needs no new ISO.

### Rule 1g: The Clock in the Bar Is the Way Back to These Settings
- The kiosk top bar shows the workstation's own date and time immediately after the network icon.
  That is deliberate: the clock is the one place a teacher can *see* that the time is wrong, so it
  is also where they can put it right.
- Clicking it opens the same administrator modal the network icon opens, with wording that names
  what is about to change, and lands on `/setup#locale` — the Language & Region step, on an
  installed workstation, behind the boot password. A student cannot reach it, and a teacher does
  not need a manual to find it.
- The time server belongs to that step: `systemd-timesyncd` is configured through a drop-in at
  `/etc/systemd/timesyncd.conf.d/labkiosk.conf` rather than by editing the package's own file, an
  empty value restores Debian's pool, and the drop-in is rewritten at every boot because it lives
  on the RAM overlay.

### Rule 1h: The Keyboard and Mouse Are Locked in Three Layers
- **Openbox only obeys a configuration it can find.** `openbox-session` reads
  `~/.config/openbox/rc.xml` and then `/etc/xdg/openbox/rc.xml`. It does **not** read
  `/etc/openbox/rc.xml`, which is where this project kept its stripped file — so installed
  workstations ran Debian's defaults and Alt+Tab, Alt+F4, Super+E, Ctrl+Alt+arrow desktop
  switching and the right-click root menu all worked. `01-lockdown.hook.chroot` now installs it to
  both paths it does read. The simulator never showed this because its entrypoint passes
  `--config-file` explicitly; when changing either, change both.
- **The X keymap is stripped before anything can read it.** `labkiosk-lock-keys` runs from the
  Openbox autostart and rewrites the keymap so every F key, both Super keys, the menu key, Print
  Screen, Pause, Scroll Lock, Insert and the whole `XF86` media and launch block carry `NoSymbol`.
  A key with no symbol is invisible to every application, Chromium's built-in accelerators
  included, and drops out of the modifier map as well. It judges a key by its *first* symbol and
  strips blocked symbols from higher levels individually — the keypad's `*` carries
  `XF86ClearGrab` on its Ctrl+Alt level, and taking the whole key would stop it typing.
  It uses `xkbcomp`, already on the image; `xmodmap` would mean 42 MB of `x11-xserver-utils`.
- **`setxkbmap` undoes it.** Any keyboard-layout change rebuilds the map from scratch and restores
  every blocked key, so the agent re-runs `labkiosk-lock-keys` after applying a layout. Anything
  else that calls `setxkbmap` must do the same.
- **The extension refuses what still arrives.** `content.js` blocks, in the capture phase, every
  Ctrl/Alt/Meta combination, every key that is not a printable character or one of
  Backspace/Delete/Enter/Shift/Caps Lock/Tab/Escape/cursor/page keys, and the context menu. It runs
  in **all frames** (`all_frames: true`) because a key pressed inside an iframe never reaches a
  listener in the parent document; the bar and the curtain still build only in the top frame.
- **One deliberate exception, and only one:** Ctrl+A/C/V/X/Z/Y on the setup wizard's own origin
  (`http://127.0.0.1:8888`). The enrolment key is a 20-character string an administrator pastes
  from the dashboard, and a kiosk that cannot paste it is a kiosk nobody can enrol. Students never
  see that origin.

### Rule 2: Universal Dual Bootloader Compatibility (BIOS + UEFI)
- Workstations in school environments range from legacy BIOS machines to modern UEFI-only hardware (e.g. Hyper-V Gen 2, modern laptops/NUCs).
- **ISO Boot:**
  - BIOS boots via **ISOLINUX** (`distro-builder/config/bootloaders/isolinux/`).
  - UEFI boots via **GRUB EFI** (`distro-builder/config/bootloaders/grub-pc/`).
- **Disk Installation:**
  - The installer partitions target drives with a **Hybrid GPT layout**:
    1. Partition 1: `bios_grub` (1 MiB – 2 MiB, flag `bios_grub on`) for legacy GRUB `i386-pc` MBR embedding on GPT.
    2. Partition 2: `ESP` (2 MiB – 514 MiB, FAT32, flag `esp on`) for UEFI bootloader files.
    3. Partition 3: `ROOT` (514 MiB – end − 513 MiB, ext4, label `LABKIOSK_ROOT`) for the immutable Debian 12 operating system.
    4. Partition 4: `DATA` (end − 512 MiB – 100%, ext4, label `LABKIOSK_DATA`) mounted at `/etc/labkiosk` with `nofail`, holding persistent credentials and `/etc/labkiosk/system-connections/`.
  - The installer runs **both** `grub-install --target=x86_64-efi --removable` and `grub-install --target=i386-pc <disk>` so the drive boots on any machine regardless of firmware mode.

### Rule 3: Decoupled Rootfs Transfer (No `EBUSY` Mount Deadlocks)
- When installing to an internal drive, `part_root` must be mounted alone during `rsync`.
- **Never mount the EFI partition (`/boot/efi`) before or during `rsync`**, and **never run `rsync` with `--delete` into a freshly formatted filesystem**.
- Violating this causes `rsync: delete_file: rmdir(boot/efi) failed: Device or resource busy (16) (code 23)`.
- Mount `part_esp` at `/boot/efi` **only after** `rsync` completes.

### Rule 4: Dynamic Runtime Session Differentiation (`is_live_session()`)
- The system must authoritatively know whether it is running from the **Live ISO / USB installer** or from an **installed internal drive**.
- Detection criteria in `agent.py` and `labkiosk-install`:
  - If `/etc/labkiosk-installed` exists: **Installed drive** (`isLive: false`).
  - If `/run/live` exists or `boot=live` in `/proc/cmdline`: **Live installer** (`isLive: true`).
- **UI Behavior in `wizard.html`**:
  - Live session: Shows sequential 2-step stepper (`Step 1: Network Setup` -> `Step 2: Choose Destination Mode [Install to Disk vs. Live Preview & Enroll]`) with badge `LIVE INSTALLER & SETUP`.
  - Installed drive: Displays badge `INSTALLED WORKSTATION`, hides the disk installer view **and the network step**, and opens directly on the enrolment form. The network was configured before the installation and came back with it, so showing it again on every boot only got in the way; it is reached from the network icon in the kiosk top bar (`/setup#network`), gated behind the administrator password modal.
- **Backend Lockout**:
  - `/api/install/disks` returns `[]` if not live.
  - `POST /api/install` rejects requests with HTTP 400 (`"System is already installed on an internal drive"`), preventing accidental data loss of the running drive.

### Rule 5: Native Top-Level Navigation & Auto-Hiding Viewport
- **Never load external educational websites inside an `<iframe>`**. Platforms like Khan Academy and YouTube enforce `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` and will fail with `ERR_BLOCKED_BY_RESPONSE`.
- Chromium must load URLs as top-level native pages.
- The Chrome extension (`content.js`) injects the navigation header into the top frame inside a **Shadow DOM** so host pages cannot alter or query it.
- **The content script never calls the agent directly.** It posts messages to `background.js` (the MV3 service worker), which owns the `host_permissions` grant for `http://127.0.0.1:8888/*`.
- The top navigation bar **must auto-hide** (`transform: translateY(-100%)`) and appear only when `mouseY <= 12px`.
- Never modify `document.body.style.marginTop`; the webpage must occupy 100% of the viewport with zero vertical scroll overflow.

### Rule 6: Loopback API Isolation
- The client agent's local API binds to `127.0.0.1:8888` only.
- All mutating endpoints (`/api/install`, `/api/reboot`, `/api/setup`, `/api/network/configure`, `/api/admin/verify`) reject requests whose `Origin` header is not loopback (`127.0.0.1` or `localhost`).
- **One origin besides loopback is accepted: the extension's own.** Chromium stamps every
  non-`GET` fetch from the MV3 service worker with `chrome-extension://<id>`, so the admin
  modal in the kiosk top bar posts to `/api/admin/verify` under that origin and nothing else
  does. `KIOSK_EXTENSION_ORIGIN` in `agent.py` is derived from `KIOSK_EXTENSION_ID`, which is
  fixed by the `key` in `manifest.json`; a page cannot forge `Origin`, and another extension
  cannot claim that id. Matching on the literal id rather than on the `chrome-extension:`
  scheme is the point — widen it and any extension would be admitted.
- `GET /api/log` returns the tail of `/tmp/lab-agent.log`, gated by the administrator token once the
  workstation is installed. It exists because a kiosk has no terminal, no getty, no SSH and blocks
  `file://`, so without it a failure in the field is unreadable. Keep it: "check the agent log" is
  not advice anyone can act on otherwise. The wizard shows it and opens it on an unexpected failure.
- Telemetry transmitted upstream to Cloudflare is authenticated with the workstation's device token.

### Rule 7: Network Configuration Persistence on `LABKIOSK_DATA`
- Network profiles configured during setup (Ethernet or Wi-Fi) are created via NetworkManager.
- Because `overlayroot="tmpfs"` reverts all rootfs modifications upon reboot, NetworkManager keyfiles in `/etc/NetworkManager/system-connections` would be wiped on power-off.
- The installer creates `/etc/labkiosk/system-connections` on the persistent `LABKIOSK_DATA` partition and configures an `/etc/fstab` bind mount:
  `/etc/labkiosk/system-connections /etc/NetworkManager/system-connections none bind,nofail 0 0`
- Network keyfiles are copied to `/etc/labkiosk/system-connections` with permissions `0600` (root:root) and directory `0700`.
- The unprivileged `kiosk` user is granted Polkit rules (`/etc/polkit-1/rules.d/50-labkiosk-network.rules`) so `agent.py` can invoke `nmcli` without sudo passwords.
- Post-install network administration via `/setup#network` requires authentication against the GRUB PBKDF2 hash stored in `/etc/grub.d/01_labkiosk_password`. The agent enforces it: `/api/admin/verify` returns a short-lived token, and `/api/network/configure` rejects an installed workstation's request that lacks it. An installation made without a password is deliberately left unlocked (the wizard warns); a password file that cannot be parsed fails closed.
- `configure_network()` validates every field (addresses via `ipaddress`, adapter names against `nmcli`, proxy host/port/bypass) **before** touching NetworkManager, then creates the profile in a single `nmcli connection add`, so a typo never leaves the workstation without a profile.
- The proxy lives only in `/etc/labkiosk/proxy.json` (persisted on `LABKIOSK_DATA`). The agent applies it to its own requests and to Chromium's `ProxySettings` policy at every start; nothing is written to `/etc/environment`.
- The extension (`content.js`) monitors network connectivity, updating top-bar icon state and redirecting to `/setup#offline` when offline for more than 6 s (never from a locked screen). The wizard returns to the lesson once the connection is back.
- `GET /api/network/status` returns a `profile` object (mode, address, gateway, DNS per family, Wi-Fi SSID, adapter) read back from the saved NetworkManager profile, and the wizard renders the form from it. Without it the page always showed its defaults and looked as though nothing had ever been configured.
- An empty Wi-Fi password field means *keep the saved passphrase*: `configure_network()` replaces the profile outright, and the passphrase is never sent back to the page, so changing a DNS server would otherwise force retyping the Wi-Fi key.

---

## 3. Automated Local Disk Installer (`labkiosk-install`)

Located at `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`.

### Execution Flags:
- `--grub-password-hash <grub.pbkdf2.sha512...>`: optional, used with `--target`. Writes
  `/etc/grub.d/01_labkiosk_password` on the installed system before `update-grub`, giving that
  installation its own boot-menu password. Only a **digest** is accepted — the setup wizard
  derives it in the browser with WebCrypto, so the plaintext never crosses the agent's API. When
  omitted, any password inherited from the live medium is removed, so an unlocked install is
  visibly unlocked. The value is re-validated here against `GRUB_PBKDF2_PATTERN`, not trusted
  from the caller.
- `--list-disks`: Scans candidate physical/virtual block devices (>= 3 GB) and returns pure JSON on
  `sys.stdout`. **The disk backing the live medium is excluded** (matched via `/proc/mounts`
  against `/run/live/medium` and friends, then resolved to its parent disk through `/sys`), because
  offering it meant a click could repartition the USB the installer was running from. Removable
  drives are *not* hidden — internal eMMC on some thin clients reports as removable — but they sort
  last and the wizard labels them, so the default selection is always an internal disk.
- `--status`: Reads `/tmp/labkiosk-install-status.json` and returns current installation state and progress percentage.
- `--target /dev/sdX`: Runs full partition, format, rootfs rsync, and GRUB deployment as root.

### Critical Implementation Standards:
1. **Zero Stdout Pollution**: All logging, traces, and debugging strings MUST write to `file=sys.stderr`. `sys.stdout` must strictly contain valid JSON so agent parsing cannot fail with `JSONDecodeError`.
2. **Kernel Fallback**: If `lsblk -J` is unavailable or returns an empty list, the installer falls back to `/sys/block` sysfs enumeration.
3. **Machine ID Reset**: The installer truncates `/etc/machine-id` on the target rootfs to a
   genuinely **empty** file, which is the marker systemd reads as "uninitialised" and replaces on
   first boot. A file containing anything else — a bare newline included — is not that marker.
4. **Negative parted offsets need `--`**: the ROOT and DATA partitions are sized from the end of the
   disk (`-513MiB`, `-512MiB`), and without a `--` separator parted parses those as bundled
   single-letter options and aborts the install.
5. **Target re-validation**: `--target` is checked against `TARGET_DISK_PATTERN` inside the
   installer, not only by the agent that normally calls it. `/etc/sudoers.d/50-labkiosk-install`
   lets the `kiosk` user run this binary directly, so the caller is not a trust boundary.

---

## 4. Verification & Testing Playbook

### 1. Client Syntax Validation
Always run before packaging or testing:
```bash
# PYTHONPYCACHEPREFIX is not optional: without it py_compile writes __pycache__
# directories *inside* config/includes.chroot, and live-build copies whatever is
# on disk straight into the ISO -- shipping bytecode built for the wrong
# interpreter into the image.
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js

# The boot-time Chromium policy is generated from the single policy base; this
# fails if the committed copy has drifted from it.
python3 distro-builder/tools/generate-chromium-policy.py --check
```

### 2. Containerized ISO Build (Docker)
Run from the repository root, on any host with a rootful Docker-compatible engine:
```bash
# Step 1: Build the builder image. The Dockerfile COPYs the source into the image's own
#         Linux filesystem -- see the bind-mount warning below for why.
docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder

# Step 2: Run live-build in a privileged container, mounting only the output directory.
docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" ghcr.io/akbhoi/labkiosk-iso-builder
```

> [!IMPORTANT]
> The container engine must be **rootful**. `live-build` runs `debootstrap`, which creates device
> nodes with `mknod`, and a rootless user namespace forbids that even under `--privileged` — the
> build dies in the chroot stage. Docker Desktop is rootful by default. If `docker` is served by a
> podman machine, make it rootful once with:
> ```bash
> podman machine stop && podman machine set --rootful && podman machine start
> ```
> Check with: `docker run --rm --privileged debian:bookworm-slim sh -c 'mknod /tmp/n b 7 99 && echo ok'`

*Note: Never bind-mount the source tree directly over `/build` in the container on Windows, because
Windows 9P/drvfs mounts enforce `nodev`/`noexec` and break `mknod`. Only `out/` is bind-mounted,
which is why the `Dockerfile` copies the source in instead.*

*Because the source is copied in, **step 1 is not optional when you have changed anything under
`distro-builder/`**. Running a stale or pulled `ghcr.io/akbhoi/labkiosk-iso-builder` image silently builds an ISO
from the source baked into it, not from the working tree, and the result looks like your change
had no effect.*

*The `.dockerignore` matters: without it the build context carries `chroot/`, `cache/` and every
previously built ISO — over a gigabyte — and, worse, a stale `lb config`-generated `config/binary`
whose `LB_BOOTAPPEND_LIVE` still contained the `quiet loglevel=3` that caused the black-screen boot
deadlock.*

### 3. Rapid Live Debugging via Docker Test Simulator
```bash
# Copy modified agent or extension into running container
docker cp distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py labkiosk-client-01:/opt/labkiosk/agent/agent.py
docker cp distro-builder/config/includes.chroot/opt/labkiosk/extension labkiosk-client-01:/opt/labkiosk/

# Relaunch agent
docker exec labkiosk-client-01 pkill -f agent.py

# Relaunch browser (watchdog relaunches within 1 second)
docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile

# Inspect logs & take visual verification screenshot
docker exec labkiosk-client-01 tail -n 25 /tmp/lab-agent.log
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/screen.png
```

---

## 5. Known Pitfalls & Solutions

| Issue | Root Cause | Solution |
| :--- | :--- | :--- |
| **`rsync: rmdir(boot/efi) failed: Device or resource busy (16)`** | `part_esp` was mounted to `/mnt/target_kiosk/boot/efi` before `rsync --delete` ran. | Mount only `part_root` during `rsync`; remove `--delete`; mount `part_esp` to `/boot/efi` only after `rsync` completes. |
| **No candidate internal drives detected** | Installer printed `[INSTALL] Executing: ...` to `sys.stdout`, corrupting JSON output parsed by `agent.py`. | Redirect all logging to `file=sys.stderr`. Reserve `sys.stdout` exclusively for `json.dumps()`. |
| **Legacy BIOS fails to boot installed GPT disk** | Legacy GRUB requires a BIOS Boot Partition to embed `core.img` on GPT disks. | Create Partition 1: `bios_grub` (1MiB-2MiB) with `set 1 bios_grub on`. |
| **UEFI boot entry missing after reboot** | UEFI firmware lost NVRAM or does not store dynamic boot variables. | Always invoke `grub-install --target=x86_64-efi --removable` to create `/boot/efi/EFI/BOOT/BOOTX64.EFI`. |
| **Alt+Tab, Alt+F4 or a right-click desktop menu works on an installed workstation** | The stripped `rc.xml` was shipped to `/etc/openbox/rc.xml`, which `openbox-session` never reads; it looks in `~/.config/openbox` and `/etc/xdg/openbox`, and fell back to Debian's defaults. The simulator hid it by passing `--config-file`. | Install `rc.xml` to both paths Openbox reads (see Rule 1h), and strip the keymap with `labkiosk-lock-keys` so the keys do not exist in the first place. |
| **Kiosk nav bar and lock curtain vanish** | Blanket extension block `ExtensionInstallBlocklist: ["*"]` prevents loading unpacked extensions. | Do not add blanket extension blocks. Chromium is already locked down via `--kiosk`, blocked `chrome://`, and wiped user profile. |
| **Freshly enrolled kiosk shows "This page is blocked"** | Chromium reads its managed policy once at startup. | Agent sets `pendingBrowserRestart` and restarts the browser after the next policy sync. |
| **A shell hook dies with `$'\r': command not found`** | The file was checked out or written with CRLF line endings. Windows git defaults to `core.autocrlf=true`, and Python's `Path.write_text` translates newlines on Windows. | `.gitattributes` pins every build and image file to `eol=lf`. Never write these files with a tool that rewrites newlines. |
| **The Language & Region step is missing, or its lists are empty** | The `locales` package or tzdata's tables are absent, so `labkiosk-localization --list-options` has nothing to report. The wizard hides the step rather than showing empty menus. | Keep `locales`, `tzdata` and `xkb-data` in `kiosk.list.chroot` (and in the simulator's Dockerfile, which is where the step gets exercised). |
| **An enrolment is accepted and then forgotten at the next reboot, with no error anywhere** | `/etc/overlayroot.conf` set `overlayroot_options="recurse=0"`, a variable overlayroot never reads. At its default `recurse=1` it overlays every fstab entry, so `/etc/labkiosk` was an overlay on RAM rather than the data partition — mounted, writable, and empty again after a reboot. | `overlayroot="tmpfs:recurse=0"` (see Rule 1a), in the image, in what the installer writes, and on every boot command line. |
| **Enrolment on an installed workstation is forgotten after a reboot** | `overlayroot="tmpfs"` sends every write to a RAM overlay, `/etc/labkiosk/config.json` included, unless the `LABKIOSK_DATA` partition is mounted there. The `nofail` fstab entry is not ordered before `local-fs.target`, so a boot-time helper that simply `mkdir -p`s the path turns a loud failure into silent data loss. | The installer creates and mounts the partition; `labkiosk-data-permissions` mounts it if the boot has not yet, and refuses to fabricate a directory when it cannot. The agent reports `persistentStorage: false` and the wizard warns before and after enrolling. On an image built before the partition existed, enrol from the live session *before* installing. |
| **Installer offers the USB it booted from** | `--list-disks` recorded the `removable` flag but never filtered on it. | `live_medium_disks()` excludes the backing disk of `/run/live/medium`, both when listing and again immediately before `wipefs`. |
| **Black screen on boot (Plymouth/NODM deadlock)** | `quiet loglevel=3` suppressed boot logs and PAM autologin was locked. | Pass `consoleblank=0` (remove `quiet loglevel=3`), unlock kiosk password (`passwd -d kiosk`), and pre-seed live-config markers. |
| **Enrolment fails with `PermissionError ... /etc/labkiosk/config.json.tmp`** | The `LABKIOSK_DATA` partition mounted at `/etc/labkiosk` is owned by root, so the unprivileged agent cannot write its enrolment. Seen on disks written by an older installer. | `labkiosk-data-permissions.service` now corrects the ownership at every boot, and the installer verifies it before declaring success. The agent's error names the owner, the mode and its own uid. |
| **The admin modal in the top bar answers "Cross-origin requests are not accepted"** | The modal's POST is issued by the extension's service worker, so Chromium sets `Origin: chrome-extension://<id>`; `_is_local_caller()` only accepted loopback origins. The wizard's own page was unaffected, which is why only the in-page modal failed. | `_is_local_caller()` also accepts `KIOSK_EXTENSION_ORIGIN`, the extension's pinned id. |
| **A just-installed machine reboots back into the installer** | The "remove the medium, press ENTER" prompt comes from `live-tools`, a *Recommends* of `live-boot` that vanished when the build stopped installing recommends. | Keep `live-tools` (and `eject`) in `kiosk.list.chroot`. USB sticks, which `live-tools` skips, are covered by `labkiosk-medium.shutdown` from the lockdown hook. |
