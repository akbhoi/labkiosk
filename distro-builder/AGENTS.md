# LabKiosk Distro Builder & Client OS — AI Agent Codex

> **Scope:** This document is the authoritative architectural specification and coding standard for the **Debian 12 Live Kiosk Operating System**, containerized ISO build pipeline, local Python agent daemon, automated hard disk installer, and Chromium Manifest V3 extension.
> For the Cloudflare edge SaaS control plane, refer to [`cloudflare-control/AGENTS.md`](../cloudflare-control/AGENTS.md). For the global invariants, see the root [`AGENTS.md`](../AGENTS.md); the client ↔ Worker contracts (telemetry, enrolment, commands, broadcast state, remote control) are in [`.agents/skills/labkiosk-core/SKILL.md`](../.agents/skills/labkiosk-core/SKILL.md).

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
│       │   ├── systemd/system/         # labkiosk-boot-ok.service; nodm
│       │   │                           #   is configured through /etc/default/nodm in
│       │   │                           #   01-lockdown.hook.chroot, and the agent is started by
│       │   │                           #   the Openbox autostart
│       │   └── systemd/system-generators/labkiosk-data-generator   # etc-labkiosk.mount by UUID
│       ├── opt/labkiosk/
│       │   ├── setup/wizard.html       # Setup & Enrollment Wizard GUI (HTML/JS)
│       │   ├── extension/              # Manifest V3: content.js (top bar & curtain) +
│       │   │                           #   background.js (service worker; sole loopback caller)
│       │   └── agent/agent.py          # Python 3 control-channel daemon & local loopback API
│       ├── usr/local/bin/
│       │   ├── labkiosk-install        # Automated Python disk installer (GPT, ESP, image store, dual GRUB)
│       │   └── labkiosk-lock-keys      # Strips blocked keys from the X keymap (Rule 1h)
│       ├── usr/local/sbin/
│       │   ├── labkiosk-localization   # The one program the agent may sudo (Rule 1e)
│       │   └── labkiosk-boot-slots     # Root-only: grubenv, one-try boot, health check, rollback
│       └── usr/share/labkiosk/         # chromium-policy-base.json (the single policy declaration)
│                                       #   plus the grub.pin build pin, version (the image's release)
│                                       #   and boot/grub.cfg (every installed disk's boot menu)
└── out/                                # Generated ISO & SHA-256 artifacts
```

---

## 2. Invariant Rules for Client Distro & Installer

### Rule 1: 100% RAM Overlay Protection (`overlayroot="tmpfs"`)

- The client OS runs as an **immutable system with all writes diverted to RAM**
  (`overlayroot="tmpfs"`, on live media and internal drives alike). `toram` — copying the entire
  image into RAM up front — is an **additional, opt-in boot menu entry**, not what the default
  entry does; `auto/config`'s `--bootappend-live` contains no `toram`.
- **An installed disk boots exactly like the ISO.** It is an image store, not a root filesystem:
  `LABKIOSK_ROOT` holds `boot/grub/` and whole system images in `images/<version>/`
  (`filesystem.squashfs`, `vmlinuz`, `initrd.img`, copied from the live medium), and the boot
  menu starts one through live-boot with `labkiosk.installed=1` on the command line. The RAM
  overlay comes from live-boot, and its lower layer is the squashfs, so an update can write a
  *different* image's folder while the system runs (`docs/OTA_UPDATES.md` §5.1). Rule 8.
- **The single exception on an installed disk is `/etc/labkiosk`**, which `etc-labkiosk.mount`
  mounts from the `LABKIOSK_DATA` partition so that a post-install enrolment survives a reboot.
  That unit is generated at boot (`etc/systemd/system-generators/labkiosk-data-generator`)
  from `labkiosk.data=<uuid>` on the command line, which `grub.cfg` takes from
  `boot/grub/labkiosk-data.cfg` (written by the installer). **Never mount it by label**: any USB
  stick can carry the label `LABKIOSK_DATA` and would hand the agent its enrolment, proxy and
  Wi-Fi profiles. No valid UUID means no mount, and the agent reports it.
  Everything else, including `/etc/machine-id`, is regenerated every boot. Nothing is written into
  a system image after installation: anything that must survive an update lives on `DATA` or in
  `boot/grub/`, and config on `DATA` is shared by every image, so its keys may be added but never
  renamed or given a new meaning (a rollback reads what the newer release wrote).
- That partition **must be owned by the `kiosk` user**: the agent runs unprivileged and writes
  `config.json` there at enrolment. Three things keep it that way, and all three should stay:
  the installer chowns the mounted partition and then *proves* the kiosk user can write to it
  (the install fails loudly otherwise); `labkiosk-data-permissions.service` re-checks it at every
  boot, before `nodm`; and `save_config()` reports the directory's owner, mode and the agent's own
  uid when a write fails, because the workstation has no shell to investigate from.
  `system-connections` inside it stays root-only — those keyfiles hold Wi-Fi passphrases.
- **A directory at `/etc/labkiosk` is not a substitute for the partition, and nothing may pretend
  otherwise.** The mount unit is `nofail`, which means systemd does not order the boot behind it,
  so that path can still be unmounted when the repair service runs. Creating a writable directory
  there is the worst available outcome: the agent enrols into the RAM overlay and the organization's
  workstation forgets everything at the next power-off, with nothing on screen to say so. The
  service therefore mounts the partition (`After=…etc-labkiosk.mount`, then mounts the
  `labkiosk.data=` UUID)
  and, when it cannot, leaves the path exactly as it found it. `enrolment_is_persistent()` in the
  agent answers the same question for the UI: `persistentStorage` in `/api/status` and `persistent`
  in the enrolment reply, both of which the wizard renders as an amber warning rather than a
  silent success.
- Thin-client SSDs and flash storage (as small as 12 GB, with limited write cycles) are protected from flash degradation.
- The underlying root filesystem **must remain mounted read-only (`ro`)**.
- All dynamic filesystem writes (browser cache, agent logs, temporary downloads, user sessions) divert strictly to `tmpfs` in RAM.
- On reboot or power loss, 100% of runtime changes and user artifacts vanish instantly.

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
  Region step is what an organization actually uses, and it writes the chosen zone at installation time;
  the build default is only what an unconfigured image comes up with.
- Everything runs on that default until then: the live session, an installed workstation, the
  workstation simulator and the ISO builder image.
- Every boot through live-boot runs live-config, and its `0070-tzdata` component rewrites
  `/etc/timezone` on every boot, defaulting to `Etc/UTC` when nothing on the kernel command line
  says otherwise. That is why `timezone=Asia/Kolkata` is on `--bootappend-live`, on
  `--bootappend-live-failsafe`, and on the hardcoded failsafe entry in all three ISO boot menus
  (`isolinux`, `syslinux`, `grub-pc`), which do not inherit `@APPEND_LIVE@`.
- An **installed** disk boots through live-boot too, and its menu
  (`usr/share/labkiosk/boot/grub.cfg`) deliberately carries **no** `timezone=`: the organization's
  zone is in `localization.json` on `LABKIOSK_DATA`, the agent re-applies it at every start, and
  a zone on the command line would be re-applied by live-config at every boot and fight it.
- Change one and change the other, or a workstation and the USB stick it was installed from will
  disagree about the time. `systemd-timesyncd` keeps the clock itself correct.

### Rule 1b: The Boot-Menu Password Is Per-Installation, and Booting Never Prompts

- A hash compiled into the ISO would be one password shared by every customer that image was
  shipped to: unrotatable in the field, and permanent in git history. So `grub.pin` stays empty
  in this repository and the password is applied at **installation** time
  (`labkiosk-install --grub-password-hash`), or per customer at build time via
  `LABKIOSK_GRUB_PBKDF2`.
- **The installed password lives outside every image**, in `boot/grub/labkiosk-password.cfg` on
  `LABKIOSK_ROOT`, which the installed `grub.cfg` sources and the agent reads (as
  `/run/live/medium/boot/grub/labkiosk-password.cfg`) to check the administrator password. A
  missing file means "no password" only when that `grub.cfg` is readable beside it; otherwise the
  gate stays shut.
- **`--unrestricted` must stay unconditional.** Every entry in the installed
  `usr/share/labkiosk/boot/grub.cfg` and the ISO's `grub-pc/grub.cfg` carries it (a test checks
  the installed one), and `02-security.hook.chroot` marks every `update-grub` entry the same way
  whether or not a password is pinned. It is a no-op without
  `superusers`, but because the password now usually arrives at install time, making it
  conditional again would give an installed disk `set superusers` with no unrestricted entry —
  and every workstation would stop at a password prompt on every boot instead of coming up into
  the kiosk.

### Rule 1c: Only What the Package List Names

- `auto/config` passes `--apt-recommends false --firmware-chroot false --firmware-binary false`. Anything the image needs is listed by name in `config/package-lists/kiosk.list.chroot`, including packages that are merely *recommended* elsewhere (`systemd-timesyncd`, `shim-signed`, `grub-efi-amd64-signed`, `xserver-xorg-video-intel`/`-qxl`) and every `firmware-*`/microcode package. Re-enabling either default puts ~1 GB of unused packages back into the ISO.
- The image has no noVNC, websockify or cloudflared: Remote Control goes from loopback x11vnc through the agent to the console's relay. The simulator's noVNC comes from the release pinned in `docker-test/novnc.pin`, installed by `docker-test/install-novnc.sh` in the simulator Dockerfile. Never add Debian's `novnc` package: it depends on Node.js and OpenStack libraries.
- Do not reintroduce `x11-xserver-utils` for `xset`: screen blanking is disabled in `10-kiosk-lockdown.conf`.
- **`live-tools` is not optional.** It ships `/lib/systemd/system-shutdown/live-tools.shutdown`, the
  "Please remove the live-medium ... press ENTER" prompt at the end of a live session. It is only a
  *Recommends* of `live-boot`, so switching recommends off silently removed it, and a machine that
  had just been installed rebooted straight back into the installer ISO. `eject` goes with it.
- `01-lockdown.hook.chroot` adds `/lib/systemd/system-shutdown/labkiosk-medium.shutdown` for the one
  case `live-tools` skips: a USB stick, which it refuses to eject because that needs a cold reboot.
  Both scripts exit immediately unless `boot=live` is on the command line. An installed disk boots
  with `boot=live` too, so its menu also passes `noeject` (which both scripts honour), and
  `labkiosk-medium.shutdown` additionally exits on `labkiosk.installed=1` — an operator's remote
  reboot of an installed workstation never waits for a keypress.
- **live-config's `sudo` and `policykit` components are pre-seeded away** in
  `01-lockdown.hook.chroot`, like `nodm` and `user-setup`. Left alone they give the live user
  (`kiosk`) `NOPASSWD: ALL` and every polkit action at every boot — on the ISO, and on every
  installed disk now that it boots through live-boot.

### Rule 1e: Language & Region Comes Before the Network, and Owns One Privileged Program

- The wizard's **first** step is Language & Region, ahead of the network on purpose: NTP is only
  reachable once the network exists, so a workstation installed in an organization with no DHCP would
  otherwise spend its first session at the wrong date — and TLS, enrolment and every page site
  care about that. The step therefore also offers the clock by hand.
- **Nothing in that step is a list this project maintains.** Continents, countries and zones come
  from tzdata's own `zone1970.tab` and `iso3166.tab`, locales from `/usr/share/i18n/SUPPORTED`
  (the `locales` package, ~21 MB), keyboard layouts from the X11 rules list. A hardcoded country
  list would be wrong by the next tzdata update.
- Setting a timezone, generating a locale and writing `/etc/default/keyboard` need root, and the
  agent does not run as root. `/usr/local/sbin/labkiosk-localization` is the only program it may
  run through sudo, and **it re-validates every argument against those same tables** — the caller
  is not a trust boundary, exactly as with `labkiosk-install`.
- The choice itself is persisted in `/etc/labkiosk/localization.json`, and `apply_saved_localization()`
  re-applies it at every agent start. On an installed disk that is the only way it comes back:
  the system image is the same for every organization and an update replaces it, so the installer
  carries `localization.json` onto `LABKIOSK_DATA` and writes nothing into the image. A locale
  other than the image's own is regenerated into RAM at every start. `--root` still exists for
  applying settings to another root, but the installer no longer uses it.
- **No zone is pre-picked.** Continent, country and time zone open on "Select…" until the operator
  chooses; only a *saved* choice (`saved.timezone`) is shown, never the image's build default, and
  Continue refuses while the zone is empty. A country with exactly one zone selects it. The build
  default is what the machine runs on until then, not an answer on the operator's behalf.

### Rule 1f: Interface Text Is Translatable, and English Is in the Markup

- Every user-visible string in `wizard.html` and in the kiosk top bar carries `data-i18n="<key>"`
  **and its English text**. The runtime replaces the text only where a catalog has that key, so a
  missing, partial or broken catalog degrades to English rather than to blank buttons.
- `en-US` ships in the image at `/opt/labkiosk/i18n/en-US.json` and is the source. Other languages
  are `<tag>.json` files dropped into `/etc/labkiosk/i18n` on the data partition — no new ISO
  needed. The agent serves them from `GET /i18n/<tag>.json`, matching the tag against a pattern
  before it ever becomes a path.
- The catalog is applied with `textContent`, never `innerHTML`: a translation is data, and an organization
  that pastes one in must not be able to inject markup into the wizard.
- **Strings set from script go through `t(key, english)`**, not a bare literal — status messages,
  errors and tooltips included. They are exactly the strings a person reads when something has
  gone wrong, and leaving them out produces a wizard that is translated until the moment it
  matters. The English stays in the call as the fallback, so the page reads correctly with no
  catalog at all.
- In the extension, `t()` lives at the top of the content script's IIFE rather than inside the
  function that builds the bar: the nav-button titles and the network tooltip are set from
  functions beside it, which would not see a `t` declared in there.
- `_meta.direction: "rtl"` flips the wizard and the bar for right-to-left languages.
- **Catalogs can also come from the control plane.** `GET /api/i18n` lists what the platform has
  and `GET /i18n/<tag>.json` serves one; both are public, because a workstation fetches its
  interface language before it is enrolled and holds no credential at that point, and the text is
  the same for every organization. Only a super admin writes them (`POST /api/super/i18n`), the upload is
  sanitised on the way in, and the agent re-checks size, shape and types on the way out — neither
  side may assume the other did.
- The agent stores a downloaded catalog in `/etc/labkiosk/i18n`, so it survives the reboot and
  needs no new ISO.

### Rule 1g: The Clock in the Bar Is the Way Back to These Settings

- The kiosk top bar shows the workstation's own date and time immediately after the network icon.
  That is deliberate: the clock is the one place an operator can *see* that the time is wrong, so it
  is also where they can put it right.
- Clicking it opens the same administrator modal the network icon opens, with wording that names
  what is about to change, and lands on `/setup#locale` — the Language & Region step, on an
  installed workstation, behind the boot password. A user cannot reach it, and an operator does
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
  Crucially, international keyboard layouts require `AltGr` (evaluated via
  `event.getModifierState("AltGraph")`) to produce special characters (e.g. `@`, `€`, `~`, `\`,
  accented letters) and dead keys (`event.key === "Dead"`). Key filtering MUST allow
  `event.getModifierState("AltGraph")` when typing characters (`key.length === 1`) or entering dead
  keys, ensuring multilingual input works without loosening the lockdown on Ctrl/Alt/Meta shortcuts.
- **One deliberate exception, and only one:** Ctrl+A/C/V/X/Z/Y on the setup wizard's own origin
  (`http://127.0.0.1:8888`). The enrolment key is a 20-character string an administrator pastes
  from the dashboard, and a kiosk that cannot paste it is a kiosk nobody can enrol. Users never
  see that origin.

### Rule 1i: Anchor Validation Patterns With `\Z`, Never `$`

- In Python, `$` matches at the end of the string **and immediately before a trailing newline**.
  Every validation pattern in this project used `$`, so a workstation name, a disk path, a locale,
  a timezone and — worst of the set — the **GRUB password digest** all accepted a value ending in
  `\n`. That digest is written into `boot/grub/labkiosk-password.cfg` as
  `password_pbkdf2 labkiosk <digest>`, so a trailing newline would have carried whatever followed
  it into that file as a second GRUB directive.
- All fifteen are now anchored with `\Z` — written `\Z` inside a raw string, **never `\\Z`**: in
  `r"..."` that is a literal backslash followed by `Z`, a pattern nothing can match. That exact slip
  in `labkiosk-localization` refused every interface language, `en-US` included, and broke
  installation. `test_client.py` now scans the three client scripts for it.
- `distro-builder/tests/test_client.py` pins this behaviour.

### Rule 2: Universal Dual Bootloader Compatibility (BIOS + UEFI)

- Workstations in organization environments range from legacy BIOS machines to modern UEFI-only hardware (e.g. Hyper-V Gen 2, modern laptops/NUCs).
- **ISO Boot:**
  - BIOS boots via **ISOLINUX** (`distro-builder/config/bootloaders/isolinux/`).
  - UEFI boots via **GRUB EFI** (`distro-builder/config/bootloaders/grub-pc/`).
- **Disk Installation:**
  - The installer partitions target drives with a **Hybrid GPT layout**:
    1. Partition 1: `bios_grub` (1 MiB – 2 MiB, flag `bios_grub on`) for legacy GRUB `i386-pc` MBR embedding on GPT.
    2. Partition 2: `ESP` (2 MiB – 514 MiB, FAT32, flag `esp on`) for UEFI bootloader files.
    3. Partition 3: `ROOT` (514 MiB – end − 513 MiB, ext4, label `LABKIOSK_ROOT`), the root-only image store: `boot/grub/` and `images/<version>/` (Rule 8).
    4. Partition 4: `DATA` (end − 512 MiB – 100%, ext4, label `LABKIOSK_DATA`) mounted at `/etc/labkiosk` with `nofail`, holding persistent credentials and `/etc/labkiosk/system-connections/`.
  - The installer runs `grub-install --target=x86_64-efi --bootloader-id=LabKiosk --no-nvram`, the same with `--removable` (firmware that loses NVRAM), and `grub-install --target=i386-pc <disk>`, each with `--boot-directory` on `ROOT`, so the drive boots on any machine regardless of firmware mode.

### Rule 3: The Installer Copies the Image, Not the Root

- The installer no longer `rsync`s the running root. It copies the live medium's
  `live/filesystem.squashfs`, `vmlinuz` and `initrd.img` into `images/<version>/` on `ROOT`, with
  the version from `/usr/share/labkiosk/version` (kept equal to `AGENT_VERSION` and the extension's
  version by a test), and installs GRUB from the live session itself with `--boot-directory`.
- **Everything is located before `wipefs`**: the image files, the version, the `grub.cfg`
  template and `labkiosk-boot-slots`. A medium that cannot produce a bootable disk fails before
  the disk is erased; a `toram` session that no longer has the medium's files is told to restart
  from the normal entry.
- ROOT, the ESP and DATA are mounted at three separate directories, never inside one another.

### Rule 4: Dynamic Runtime Session Differentiation (`is_live_session()`)

- The system must authoritatively know whether it is running from the **Live ISO / USB installer** or from an **installed internal drive**.
- Detection criteria in `agent.py` and `labkiosk-install`:
  - If `labkiosk.installed=1` is on the kernel command line (or, for a disk installed before the
    image store, `/etc/labkiosk-installed` exists): **Installed drive** (`isLive: false`). This is
    checked first because an installed disk also has `/run/live` and `boot=live`.
  - Otherwise, if `/run/live` exists or `boot=live` in `/proc/cmdline`: **Live installer** (`isLive: true`).
- **UI Behavior in `wizard.html`**:
  - Live session: Shows a sequential 3-step stepper (`Language & Region` -> `Network Setup` -> `Install or Preview` [Install to Disk vs. Live Preview & Enroll]) with badge `LIVE INSTALLER & SETUP`.
  - Installed drive: Displays badge `INSTALLED WORKSTATION`, hides the disk installer view **and the network step**, and opens directly on the enrolment form. The network was configured before the installation and came back with it, so showing it again on every boot only got in the way; it is reached from the network icon in the kiosk top bar (`/setup#network`), gated behind the administrator password modal.
  - **Wizard Responsiveness & Offline Resiliency**:
    - The setup wizard (`wizard.html`) enforces `.wizard-card { margin: auto; }` and `body { overflow-y: auto; }` within its flex container so that cards are centered on large screens while remaining fully scrollable without top-clipping on small viewports (e.g. 1024x768 or 800x600).
    - `#btn-locale-languages` is hidden by default and displayed only on configured workstations.
    - When the user cancels the administrator modal during an offline redirect (`#offline`), the wizard closes the modal without re-triggering `returnToKiosk()`, breaking the redirect loop.
    - Dynamic prompt text distinguishes between network and locale changes (`admin.promptLocale` vs `admin.prompt`).
- **Backend Lockout**:
  - `/api/install/disks` returns `[]` if not live.
  - `POST /api/install` rejects requests with HTTP 400 (`"System is already installed on an internal drive"`), preventing accidental data loss of the running drive.

### Rule 5: Native Top-Level Navigation & Auto-Hiding Viewport

- **Never load external approved websites inside an `<iframe>`**. Platforms like Khan Academy and YouTube enforce `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` and will fail with `ERR_BLOCKED_BY_RESPONSE`.
- Chromium must load URLs as top-level native pages.
- The Chrome extension (`content.js`) injects the navigation header into the top frame inside a **Shadow DOM** so host pages cannot alter or query it.
- **The content script never calls the agent directly.** It posts messages to `background.js` (the MV3 service worker), which owns the `host_permissions` grant for `http://127.0.0.1:8888/*`.
- The top navigation bar **must auto-hide** (`transform: translateY(-100%)`) and appear only when `mouseY <= 12px`.
- Never modify `document.body.style.marginTop`; the webpage must occupy 100% of the viewport with zero vertical scroll overflow.
- **Event-Driven Workstation Reload (`reloadEpoch`)**: Synthetic key injection (`xdotool key F5`) is
  forbidden in `agent.py` — in production, `xdotool` is uninstalled, fails silently, and cannot
  target unmapped or background windows. Instead, operator `reload` commands advance `reloadEpoch`
  in the agent's state (served via `GET /api/status`). The browser extension (`content.js`) monitors
  `reloadEpoch` during its 1-second `syncLoop()` and triggers native `window.location.reload()`.
  To prevent infinite reload loops across page reloads, `content.js` caches `lastReloadEpoch` in
  `sessionStorage`.
- **Clear Session Without a Reboot (`clear-session`)**: at the end of a session the operator
  signs every user out while the workstation stays up. The agent only ends Chromium
  (`restart_browser()`, matched on `--user-data-dir=/tmp/chromium-profile`); the watchdog in the
  Openbox autostart and in `docker-test/entrypoint.sh` runs `rm -rf /tmp/chromium-cache
  /tmp/chromium-profile` before **every** relaunch, which removes cookies, saved sign-ins, history,
  local storage, IndexedDB and service workers. The in-memory HTTP auth cache and the X clipboard
  die with the process, and the managed policy already disables the password manager, sync and
  downloads, so nothing is left elsewhere. Keep the wipe in the watchdog: deleting the profile from
  the agent while Chromium still has it open would race its writes. Both launchers must keep that
  `rm -rf` and the same `--user-data-dir`, and `test_client.py` fails if either stops. The relaunch
  opens the workstation's assigned page (`targetUrl`: the portal, or the live broadcast).
- **Query Parameter Preservation**: URL normalization in `content.js` (`normalizeUrl()`) strictly
  preserves query parameters (`u.search`), ensuring learning apps relying on stateful query
  strings (e.g. `?room=101&user=demo`) are not stripped or falsely identified as root broadcast URLs.
- **RTL/LTR Layout Adaptation**: The extension dynamically applies `dir="rtl"` or `dir="ltr"`
  to the host element, kiosk top bar, lock curtain, and admin modal based on `_meta.direction`
  in the active interface catalog.

### Rule 6: Loopback API Isolation

- The client agent's local API binds to `127.0.0.1:8888` only.
- All mutating endpoints (`/api/install`, `/api/reboot`, `/api/setup`, `/api/network/configure`, `/api/admin/verify`) reject requests whose `Origin` header is not loopback (`127.0.0.1` or `localhost`).
- On installed workstations, `POST /api/reboot` and `POST /api/network/configure` require administrator authentication via `X-LabKiosk-Admin` session token (issued by `/api/admin/verify` after verifying against the GRUB PBKDF2 hash). Unauthenticated reboots on installed hardware fail closed with `401 Unauthorized`.
- **One origin besides loopback is accepted: the extension's own.** Chromium stamps every
  non-`GET` fetch from the MV3 service worker with `chrome-extension://<id>`, so the admin
  modal in the kiosk top bar posts to `/api/admin/verify` under that origin and nothing else
  does. `KIOSK_EXTENSION_ORIGIN` in `agent.py` is derived from `KIOSK_EXTENSION_ID`, which is
  fixed by the `key` in `manifest.json`; a page cannot forge `Origin`, and another extension
  cannot claim that id. Matching on the literal id rather than on the `chrome-extension:`
  scheme is the point — widen it and any extension would be admitted.
- **The log is trimmed in place, not rotated.** `/tmp` is a tmpfs, so the log is RAM on a machine
  that may only have 2 GB of it, and the agent is at its most talkative exactly when something is
  wrong and a workstation is left running. `log()` keeps the last 128 KB once the file passes 1 MB.
  It cannot rename the file: the Openbox autostart owns it through a `>>` redirect, and a rename
  would leave the shell appending to an inode nobody can read. Truncating under an `O_APPEND`
  writer is safe — the next line lands after what was kept.
- `GET /api/log` returns the tail of `/tmp/lab-agent.log`, gated by the administrator token once the
  workstation is installed. It exists because a kiosk has no terminal, no getty, no SSH and blocks
  `file://`, so without it a failure in the field is unreadable. Keep it: "check the agent log" is
  not advice anyone can act on otherwise. The wizard shows it and opens it on an unexpected failure.
- Telemetry transmitted upstream to Cloudflare is authenticated with the workstation's device token.
- **The organization server is `https`, except a local test server.** `validate_worker_url()` accepts
  plain `http` only for loopback, the container gateways, and a private IPv4 literal
  (`is_private_ip_literal()`: `10/8`, `172.16/12`, `192.168/16`) — the same set as `isDevHost()`
  on the control plane, so a test VM can enrol against `pnpm dev` by its host's address
  (`http://172.31.64.1:8787` on the Hyper-V Default Switch). Never widen it to a hostname or a
  public address: the device token rides in every heartbeat.

### Rule 6b: A Workstation Is Never Stranded

- **A refused device token sends the screen to re-enrolment.** When the control plane refuses
  the token — `/api/telemetry` or the WebSocket handshake answers 401/403, or the hub closes the
  socket with `4001` (removed) or `4003` (organization not active) — `mark_enrolment_rejected()`
  sets `enrolmentRejected`, points `targetUrl` at `http://127.0.0.1:8888/setup#reenrol` — which
  the boot-time policy always allows — and restarts the browser once. It used to only log it:
  the kiosk kept its old home page with no allowlist, and after a reboot sat on Chromium's "This
  page is blocked" with no bar and no way back but a reinstall. The enrolment on disk is kept; a
  mistaken refusal on the server must not wipe a healthy workstation.
- **Registering again is possible, and password-gated.** `/api/setup` on an enrolled workstation
  needs the administrator token (`X-LabKiosk-Admin`) wherever `admin_auth_required()`, like the
  network page and reboot; it used to answer 409 outright. A re-enrolment clears the old
  organization's broadcast and lock, and wakes the heartbeat (`heartbeat_wakeup`) so the new
  allowlist arrives at once instead of after up to a minute of back-off. The wizard's `#reenrol`
  mode shows why it is there, and a healthy workstation reaches it from the network page
  ("Register with Another Organization…").
- **No page without the bar.** Chromium's block and network-error pages are `chrome-error://`,
  where no extension runs. `background.js` (`webNavigation.onErrorOccurred`, top frame only,
  never for the agent's own origin) sends a policy block to `/blocked`, a network error to
  `/setup#offline` when the agent says the workstation is offline, and to
  `/blocked?reason=unreachable` when it is online (the offline page would bounce back to the dead
  site and loop). `/blocked` retries the original `http(s)` address once after 7 s — a broadcast
  allowlists its site in the same heartbeat that sends the screen there, and Chromium rereads a
  changed policy only after a few seconds — then stays, with Try again, Back and Home.

- **A reboot must not block the home page.** The RAM overlay brings back the boot-time policy
  (loopback only), and the launcher opens the saved home page as soon as `/api/status` answers —
  on real hardware, seconds before the network lets the agent reach the control plane. So an
  enrolled agent writes the policy for its own server and home page from the saved enrolment
  **before** it starts the local API (`main()`); the organization's full allowlist follows on the
  first update. It used to wait for the control plane, and every reboot landed on "This page is
  blocked".
- **An error from before the extension started is still recovered.** That first navigation
  fails while Chromium is starting, before the service worker listens, so `onErrorOccurred`
  never fires for it. `recoverMissedErrors()` in `background.js` runs whenever the worker starts
  and sends any tab whose top frame shows an error (`webNavigation.getAllFrames`,
  `errorOccurred`) to `/blocked` or `/setup#offline`. Reproduce either in the simulator: put the
  boot-time `policies.json` back, pause the control plane, and restart the agent and Chromium
  together.

### Rule 6c: One Control Channel, With a Fallback That Always Works

- The agent keeps **one WebSocket** to its organization's OrgHub (`/api/devices/ws`,
  `ControlChannel` in `agent.py`), instead of posting a heartbeat every 3 seconds. The hub pushes
  the allowlist, target, broadcast and commands as they change and asks for screen frames only
  while an operator watches, so a quiet workstation takes no screenshots and costs the control
  plane nothing. Contracts: `labkiosk-core` §1.
- It needs **`python3-websocket`** (Debian's websocket-client), which is in `kiosk.list.chroot`
  and the simulator's Dockerfile. The import is guarded: without the package the agent runs
  exactly as before, on the HTTP heartbeat.
- **HTTP is the fallback, never removed.** A handshake answered `404`/`426`/`501` (a Worker without
  the route, or the Node development server) or three failed connections in a row switch to the
  HTTP heartbeat for 10 minutes. An organization proxy that drops WebSocket upgrades therefore
  costs efficiency, not control.
- **The ping is a literal.** `WEBSOCKET_PING` must stay byte-identical to the hub's
  `HUB_PING` (`{"type":"ping"}`, no spaces): the edge answers that exact message without waking the
  hub. `json.dumps` would add a space and bill every ping; `test_client.py` compares the two.
- One thread: every receive waits at most 0.5 s, then the loop sends what is due. The socket
  honours the saved proxy (`load_proxy_config()` passed explicitly), and `heartbeat_wakeup` — set by
  a new enrolment — closes it so the new token connects at once.

### Rule 7: Network Configuration Persistence on `LABKIOSK_DATA`

- Network profiles configured during setup (Ethernet or Wi-Fi) are created via NetworkManager.
- Because `overlayroot="tmpfs"` reverts all rootfs modifications upon reboot, NetworkManager keyfiles in `/etc/NetworkManager/system-connections` would be wiped on power-off.
- The installer creates `/etc/labkiosk/system-connections` on the persistent `LABKIOSK_DATA` partition, and the image's `etc-NetworkManager-system\x2dconnections.mount` (written by `01-lockdown.hook.chroot`, conditional on `labkiosk.installed=1`, ordered before NetworkManager) bind-mounts it over `/etc/NetworkManager/system-connections`.
- Network keyfiles are copied to `/etc/labkiosk/system-connections` with permissions `0600` (root:root) and directory `0700`.
- The unprivileged `kiosk` user is granted Polkit rules (`/etc/polkit-1/rules.d/50-labkiosk-network.rules`) so `agent.py` can invoke `nmcli` without sudo passwords.
- Post-install network administration via `/setup#network` requires authentication against the GRUB PBKDF2 hash stored in `boot/grub/labkiosk-password.cfg` on `LABKIOSK_ROOT`. The agent enforces it: `/api/admin/verify` returns a short-lived token, and `/api/network/configure` rejects an installed workstation's request that lacks it. An installation made without a password is deliberately left unlocked (the wizard warns); a password file that cannot be parsed, or a boot partition that cannot be read, fails closed.
- `configure_network()` validates every field (addresses via `ipaddress`, adapter names against `nmcli`, proxy host/port/bypass) **before** touching NetworkManager, then creates the profile in a single `nmcli connection add`, so a typo never leaves the workstation without a profile.
- The proxy lives only in `/etc/labkiosk/proxy.json` (persisted on `LABKIOSK_DATA`). The agent applies it to its own requests and to Chromium's `ProxySettings` policy at every start; nothing is written to `/etc/environment`.
- The extension (`content.js`) monitors network connectivity, updating top-bar icon state and redirecting to `/setup#offline` when offline for more than 6 s (never from a locked screen). The wizard returns to the page once the connection is back.
- `GET /api/network/status` returns a `profile` object (mode, address, gateway, DNS per family, Wi-Fi SSID, adapter) read back from the saved NetworkManager profile, and the wizard renders the form from it. Without it the page always showed its defaults and looked as though nothing had ever been configured.
- An empty Wi-Fi password field means *keep the saved passphrase*: `configure_network()` replaces the profile outright, and the passphrase is never sent back to the page, so changing a DNS server would otherwise force retyping the Wi-Fi key.

### Rule 8: One Try for a New Image, Then Roll Back on Its Own

- `LABKIOSK_ROOT/boot/grub/grubenv` holds `current`, `previous`, `next` and `next_tries`, written
  only by root (`labkiosk-boot-slots`, atomically: new file, fsync, rename) and by GRUB itself.
- The installed `grub.cfg` (copied from `usr/share/labkiosk/boot/grub.cfg`, the same for every
  machine and release) boots `current`. With `next` set and `next_tries=1` it **spends the try
  first** (`save_env next_tries` = 0) and boots `next` only if that write succeeded; then it falls
  back to `current`, `previous`, and finally any complete image in `images/`, so a damaged
  `grubenv` never leaves the machine at a menu. Every entry is `--unrestricted`.
- The command line is `boot=live components … live-media=/dev/disk/by-uuid/<ROOT> live-media-path=/images/<v>
  labkiosk.installed=1 noeject panic=10`, with no `timezone=` (Rule 1d). By UUID, not label: a
  second disk that was once a Lab Kiosk install has the same label (the label is only the fallback
  if GRUB's `probe` is unavailable). `panic=10` turns a panic,
  including live-boot failing to find its image, into a reboot, which GRUB answers with the old image.
- `labkiosk-boot-ok.service` runs `labkiosk-boot-slots check` at every installed boot. On the one
  try it waits until the agent's API answers and Chromium (`--user-data-dir=/tmp/chromium-profile`)
  runs, continuously for 60 s within 10 minutes, then makes `next` current and the old image
  `previous`; if that never happens it reboots, and GRUB boots the old image. Every boot writes
  the outcome (`running`, `staged`, `finishing`, `installed`, `failed`, `rolled-back`, `fallback`,
  and `error` when `grubenv` cannot be read or the promotion cannot be written) to
  `/run/labkiosk-update/status.json`, root-written — never to `DATA`, which the browser's user can
  write. A write that fails still fails the command (fail closed); the agent sends `installed`,
  `failed`, `rolled-back`, `fallback` and `error` to `POST /api/devices/boot-report`; problems
  show in the console under Settings → Errors & Warnings (`labkiosk-core` §2b).
- `labkiosk-boot-slots try <version>` gives an image already on disk its one try at the next boot
  (the primitive the updater will use). There is no sudo rule for it: the agent never chooses what
  boots. The health check reaches the loopback agent with no proxy (an organization proxy must not
  decide whether an image is healthy).
- The installed kiosk has no shell (getty masked, no SSH). To try a slot by hand, mount
  `LABKIOSK_ROOT` from another system and run `grub-editenv boot/grub/grubenv set next=<v> next_tries=1`.
- `labkiosk-update` (root only, no sudo rule; phase 2) downloads a signed release by hand:
  `download URL` verifies `manifest.json.sig` with `gpgv` against
  `/usr/share/labkiosk/update-keys/*.gpg` only, refuses a version below
  `/usr/share/labkiosk/security-floor`, fetches into `LABKIOSK_ROOT/downloads/<v>/` (HTTP Range
  resume, every chunk hashed before it is written) and renames to `images/<v>/` only after every
  file's sha256 is re-verified and `.verified` is written. A download is **never** written inside
  `images/`: GRUB's last resort boots any complete folder there. `install VERSION` re-verifies and
  sets `next`; `status` prints JSON. The ISO build fails without two release-signing public keys
  in `update-keys/` (`02-security.hook.chroot`).
- Phases 3–5 of `docs/OTA_UPDATES.md` §9 (the automatic trigger, approval UI, curtain, security
  rebuilds and LAN sharing) are research; never document or depend on them as features.

---

## 3. Automated Local Disk Installer (`labkiosk-install`)

Located at `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`.

### Execution Flags

- `--grub-password-hash <grub.pbkdf2.sha512...>`: optional, used with `--target`. Writes
  `boot/grub/labkiosk-password.cfg` on `ROOT`, giving that installation its own boot-menu
  password; it sits outside every image, so updates keep it. Only a **digest** is accepted — the
  setup wizard derives it in the browser with WebCrypto, so the plaintext never crosses the
  agent's API. When omitted, no password file is written, so an unlocked install is visibly
  unlocked. The value is re-validated here against `GRUB_PBKDF2_PATTERN`, not trusted from the
  caller.
- `--list-disks`: Scans candidate physical/virtual block devices (>= 7 GiB, so a drive sold as 8 GB qualifies: two system images side by side) and returns pure JSON on
  `sys.stdout`. **The disk backing the live medium is excluded** (matched via `/proc/mounts`
  against `/run/live/medium` and friends, then resolved to its parent disk through `/sys`), because
  offering it meant a click could repartition the USB the installer was running from. Removable
  drives are *not* hidden — internal eMMC on some thin clients reports as removable — but they sort
  last and the wizard labels them, so the default selection is always an internal disk.
- `--status`: Reads `/tmp/labkiosk-install-status.json` and returns current installation state and progress percentage.
- `--target /dev/sdX`: Runs full partition, format, image copy, and GRUB deployment as root.

### Critical Implementation Standards

1. **Zero Stdout Pollution**: All logging, traces, and debugging strings MUST write to `file=sys.stderr`. `sys.stdout` must strictly contain valid JSON so agent parsing cannot fail with `JSONDecodeError`.
2. **Kernel Fallback**: If `lsblk -J` is unavailable or returns an empty list, the installer falls back to `/sys/block` sysfs enumeration.
3. **Machine ID**: `01-lockdown.hook.chroot` empties `/etc/machine-id` in the image, the marker
   systemd reads as "uninitialised", so every boot generates one in RAM. The installer writes
   nothing into the image; an id baked into the squashfs would be shared by every workstation.
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
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install \
  distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-localization \
  distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-boot-slots
sh -n distro-builder/config/includes.chroot/etc/systemd/system-generators/labkiosk-data-generator
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js

# The client's own validators: the loopback boundary, URL and catalog checks,
# the persistence test, the locale spellings and the keyboard lockdown.
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover \
  -s distro-builder/tests -t distro-builder/tests

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
>
> ```bash
> podman machine stop && podman machine set --rootful && podman machine start
> ```
>
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

### 2b. Installed-Disk Boot Test (QEMU)

`.github/workflows/build-iso.yml` runs `distro-builder/tests/vm/boot-test.sh` on every built ISO:
the ISO's own installer writes a virtual disk, which then boots under QEMU + OVMF (UEFI, KVM)
through four scenarios — promote, broken squashfs, recover, unhealthy image — read back from
`grubenv`. BIOS is covered only by the GRUB menu tests in `test_client.py`. It needs root and
`/dev/kvm`, so it does not run on Windows:

```bash
sudo distro-builder/tests/vm/boot-test.sh distro-builder/out/labkiosk-debian12-amd64.iso
```

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
| **No candidate internal drives detected** | Installer printed `[INSTALL] Executing: ...` to `sys.stdout`, corrupting JSON output parsed by `agent.py`. | Redirect all logging to `file=sys.stderr`. Reserve `sys.stdout` exclusively for `json.dumps()`. |
| **Legacy BIOS fails to boot installed GPT disk** | Legacy GRUB requires a BIOS Boot Partition to embed `core.img` on GPT disks. | Create Partition 1: `bios_grub` (1MiB-2MiB) with `set 1 bios_grub on`. |
| **UEFI boot entry missing after reboot** | UEFI firmware lost NVRAM or does not store dynamic boot variables. | Always invoke `grub-install --target=x86_64-efi --removable` to create `/boot/efi/EFI/BOOT/BOOTX64.EFI`. |
| **Alt+Tab, Alt+F4 or a right-click desktop menu works on an installed workstation** | The stripped `rc.xml` was shipped to `/etc/openbox/rc.xml`, which `openbox-session` never reads; it looks in `~/.config/openbox` and `/etc/xdg/openbox`, and fell back to Debian's defaults. The simulator hid it by passing `--config-file`. | Install `rc.xml` to both paths Openbox reads (see Rule 1h), and strip the keymap with `labkiosk-lock-keys` so the keys do not exist in the first place. |
| **Kiosk nav bar and lock curtain vanish** | Blanket extension block `ExtensionInstallBlocklist: ["*"]` prevents loading unpacked extensions. | Do not add blanket extension blocks. Chromium is already locked down via `--kiosk`, blocked `chrome://`, and wiped user profile. |
| **Freshly enrolled kiosk shows "This page is blocked"** | Chromium reads its managed policy once at startup. | Agent sets `pendingBrowserRestart` and restarts the browser after the next policy sync. |
| **Every reboot lands on "This page is blocked" with no top bar, though enrolment worked** | The boot-time policy allows only loopback, Chromium opened the home page before the agent could reach the control plane, and that first error happened before the extension's service worker was listening. | The agent allows its own server and home page before its API answers, and `recoverMissedErrors()` moves any tab already on an error page (Rule 6b). |
| **A workstation shows "This page is blocked" with no top bar and no way back** | Its organization was deleted (or it was removed), the agent only logged the 401, and Chromium's block page is `chrome-error://`, where the extension never runs. | See Rule 6b: the agent retargets to `/setup#reenrol`, `/api/setup` re-enrols behind the admin password, and the extension replaces error pages with `/blocked` or `/setup#offline`. |
| **A shell hook dies with `$'\r': command not found`** | The file was checked out or written with CRLF line endings. Windows git defaults to `core.autocrlf=true`, and Python's `Path.write_text` translates newlines on Windows. | `.gitattributes` pins every build and image file to `eol=lf`. Never write these files with a tool that rewrites newlines. |
| **The Language & Region step is missing, or its lists are empty** | The `locales` package or tzdata's tables are absent, so `labkiosk-localization --list-options` has nothing to report. The wizard hides the step rather than showing empty menus. | Keep `locales`, `tzdata` and `xkb-data` in `kiosk.list.chroot` (and in the simulator's Dockerfile, which is where the step gets exercised). |
| **An enrolment is accepted and then forgotten at the next reboot, with no error anywhere** | `/etc/overlayroot.conf` set `overlayroot_options="recurse=0"`, a variable overlayroot never reads. At its default `recurse=1` it overlays every fstab entry, so `/etc/labkiosk` was an overlay on RAM rather than the data partition — mounted, writable, and empty again after a reboot. | `overlayroot="tmpfs:recurse=0"` (see Rule 1a), in the image, in what the installer writes, and on every boot command line. |
| **Enrolment on an installed workstation is forgotten after a reboot** | `overlayroot="tmpfs"` sends every write to a RAM overlay, `/etc/labkiosk/config.json` included, unless the `LABKIOSK_DATA` partition is mounted there. The `nofail` mount unit is not ordered before `local-fs.target`, so a boot-time helper that simply `mkdir -p`s the path turns a loud failure into silent data loss. | The installer creates and mounts the partition; `labkiosk-data-permissions` mounts it if the boot has not yet, and refuses to fabricate a directory when it cannot. The agent reports `persistentStorage: false` and the wizard warns before and after enrolling. On an image built before the partition existed, enrol from the live session *before* installing. |
| **Installer offers the USB it booted from** | `--list-disks` recorded the `removable` flag but never filtered on it. | `live_medium_disks()` excludes the backing disk of `/run/live/medium`, both when listing and again immediately before `wipefs`. |
| **Black screen on boot (Plymouth/NODM deadlock)** | `quiet loglevel=3` suppressed boot logs and PAM autologin was locked. | Pass `consoleblank=0` (remove `quiet loglevel=3`), unlock kiosk password (`passwd -d kiosk`), and pre-seed live-config markers. |
| **Enrolment fails with `PermissionError ... /etc/labkiosk/config.json.tmp`** | The `LABKIOSK_DATA` partition mounted at `/etc/labkiosk` is owned by root, so the unprivileged agent cannot write its enrolment. Seen on disks written by an older installer. | `labkiosk-data-permissions.service` now corrects the ownership at every boot, and the installer verifies it before declaring success. The agent's error names the owner, the mode and its own uid. |
| **The admin modal in the top bar answers "Cross-origin requests are not accepted"** | The modal's POST is issued by the extension's service worker, so Chromium sets `Origin: chrome-extension://<id>`; `_is_local_caller()` only accepted loopback origins. The wizard's own page was unaffected, which is why only the in-page modal failed. | `_is_local_caller()` also accepts `KIOSK_EXTENSION_ORIGIN`, the extension's pinned id. |
| **Installing fails with `'en-US' is not a language tag`** | `labkiosk-localization` checked `--ui-language` with an inline `r"...\\Z"`, which demands a literal backslash, so every tag failed — the wizard's Continue and the installer's copy onto the disk alike. | `UI_LANGUAGE_PATTERN` (same as the agent's) anchored with `\Z`; tests pin both patterns and forbid `\\Z` in raw strings. |
| **A just-installed machine reboots back into the installer** | The "remove the medium, press ENTER" prompt comes from `live-tools`, a *Recommends* of `live-boot` that vanished when the build stopped installing recommends. | Keep `live-tools` (and `eject`) in `kiosk.list.chroot`. USB sticks, which `live-tools` skips, are covered by `labkiosk-medium.shutdown` from the lockdown hook. |
