# Client Kiosk OS & ISO Distro Builder

[← Back to Documentation Hub](../README.md#documentation-hub)

A minimal, security-hardened Debian 12 (Bookworm) live kiosk operating system designed for educational workstation fleets and thin-client workstations.

---

## 🌟 Architecture & Operating System Design

The Lab Kiosk operating system is built specifically for resource-constrained thin clients (e.g., Intel Celeron/Pentium, 4 GB RAM, 12 GB SATA SSD) with an immutable, zero-wear storage model.

### 1. 100% RAM Overlay (`overlayroot="tmpfs"`)

- The root filesystem is mounted strictly read-only (`ro`), with a `tmpfs` overlay on top.
- **`toram` is an opt-in boot entry, not the default.** The default entry
  (`auto/config`, `--bootappend-live`) boots with `overlayroot=tmpfs` and reads the squashfs from
  the medium as it goes. The boot menu additionally offers **Lab Kiosk OS (Load into RAM - toram)**,
  which copies the whole image into RAM first: pick it when the USB stick should be removable after
  boot, and expect it to need RAM greater than the image size.
- Dynamic runtime file system writes (browser cache, agent logs, temporary downloads, user session state) are diverted to a `tmpfs` RAM disk via `overlayroot`.
- **Zero SSD Wear Guarantee:** Thin-client flash storage is never written to during operation, eliminating drive exhaustion and wear cycles.
- On reboot or power-off, all user session state, cached files, and temporary artifacts vanish instantly.

### 2. Hardened Operating System Lockdown

- **TTY & Console Masking:** Virtual consoles `tty1` through `tty6` are masked in systemd. VT switching is disabled at the X server level via `DontVTSwitch` and `DontZap` options in `/etc/X11/xorg.conf.d/10-kiosk-lockdown.conf`.
- **Stripped Window Manager:** Openbox runs with an empty keybinding table in `/etc/openbox/rc.xml`. Shortcuts such as `Alt+Tab`, `Alt+F4`, `Ctrl+Alt+Del`, and custom key sequences are completely inert.
- **Account Restrictions:** `root` is locked (`passwd -l`). The `kiosk` account has an *empty*
  password rather than a locked one, because a locked account previously deadlocked nodm's PAM
  stack into a black screen on boot; what makes that safe is that no login path exists to use it —
  `getty@tty1..6`, `serial-getty` and `debug-shell` are all masked and no SSH server is installed.
  `kiosk` holds exactly one sudo grant, `NOPASSWD` on `/usr/local/bin/labkiosk-install`
  (`/etc/sudoers.d/50-labkiosk-install`), which is what lets the setup wizard run the guided disk
  installer. There is no general sudo access.
- **Polkit Power Policy:** `/etc/polkit-1/rules.d/50-labkiosk-power.rules` grants the `kiosk` user
  reboot and power-off through logind, and nothing else. That grant is what makes the operator's
  remote shutdown command work — the agent runs as `kiosk`, so without it the command would be
  accepted and then silently do nothing.

### 3. Chromium Enterprise Kiosk & Manifest V3 Extension

- **Top-Level Native Browsing:** External approved platforms (Khan Academy, YouTube, Scratch) enforce strict `X-Frame-Options` and `frame-ancestors` headers. Lab Kiosk loads all web destinations as native top-level pages, avoiding iframe embedding limitations.
- **Auto-Hiding Navigation Bar:** An unpacked Manifest V3 Chromium extension injects an auto-hiding 44px navigation bar into top-level pages inside a Shadow DOM.
  - Controls: Home, Back, Forward, Reload, and Status Shield.
  - Behavior: Auto-hides via `transform: translateY(-100%)` and smoothly transitions into view only when the mouse cursor enters the top 12 pixels (`mouseY <= 12px`).
  - Viewport: Occupies 100% of the viewport with `0px` vertical scroll overflow without mutating `document.body.style.marginTop`.
- **Lock Curtain ("Eyes to the Front"):** Full-screen DOM overlay displayed across all open tabs upon operator command. Swallows keyboard and mouse input events and displays customized operator announcements.
- **Extension Communication Architecture:**
  - `content.js` runs in the page context inside an isolated Shadow DOM. It **never** fetches from the local agent directly (which would require unsafe wildcard CORS).
  - `content.js` messages `background.js` (MV3 service worker) via `chrome.runtime.sendMessage`.
  - `background.js` owns the `host_permissions` grant for `http://127.0.0.1:8888/*` and communicates with the local agent daemon.
- **No Blanket Extension Block:** The enterprise policy deliberately avoids `ExtensionInstallBlocklist: ["*"]`, which would prevent loading unpacked extensions via `--load-extension`. User extensions remain blocked because `chrome://` is blocked, Chrome Web Store is not allowlisted, and browser profiles are wiped on launch.

### 4. Local Python 3 Daemon (`agent.py`)

- Resides at `/opt/labkiosk/agent/agent.py`. It is **not** a systemd service: it needs the kiosk
  user's live X session for `scrot` and `xdotool`, so it is started from `/etc/openbox/autostart`
  inside a `while true` supervisor loop that restarts it within ~2 s if it ever exits. Restart
  lines are written to `/tmp/lab-agent.log`.
- **Telemetry Loop (Every 3s):** Authenticates to the Cloudflare control plane with a stored bearer
  device token, transmits a screen thumbnail, receives pending operator commands, and checks
  broadcast status. The thumbnail is produced by `scrot -t 20 -q 35` — pure Python standard
  library plus `scrot`, with **no PIL/Pillow dependency** — and a frame whose base64 payload
  exceeds 256 KB (`MAX_THUMBNAIL_BYTES`) is dropped rather than sent, so an oversized capture
  never costs the organization's uplink or delays the heartbeat.
- **Local API:** threaded (`ThreadingHTTPServer`), so a slow call such as the disk scan cannot
  stall the once-a-second status poll that drives the lock curtain.
- **Dynamic Policy Synchronization:** Writes the tenant's approved domain allowlist into `/etc/chromium/policies/managed/policies.json`.
- **Loopback API:** Binds strictly to `127.0.0.1:8888` to serve the first-boot onboarding wizard and health probes.
- **Session State Awareness:** Distinguishes between live evaluation sessions (`boot=live` on USB/ISO) and permanent disk installations.

### 5. Automated Hard Disk Installer (`labkiosk-install`)

- Resides at `/usr/local/bin/labkiosk-install` and can be invoked directly from the terminal or via the Setup Wizard GUI.
- **Universal Hybrid GPT Partitioning:**
  1. `bios_grub` (1 MiB – 2 MiB): Enables legacy BIOS GRUB embedding on GPT partitioned disks.
  2. `ESP` (2 MiB – 514 MiB, FAT32): Holds the UEFI bootloader and configuration.
  3. `ROOT` (514 MiB – 513 MiB from the end, ext4, label `LABKIOSK_ROOT`): the immutable Debian 12
     operating system.
  4. `DATA` (last 512 MiB, ext4, label `LABKIOSK_DATA`): mounted at `/etc/labkiosk` with `nofail`.
     This is the **only** part of an installed machine that survives a reboot, and it exists so
     that a workstation enrolled *after* installation stays enrolled — every other write goes to
     the RAM overlay and is discarded at power-off.
- **Refuses to erase the medium it is running from:** candidate disks are matched against the
  device backing `/run/live/medium`, and that disk is excluded from the list *and* rejected again
  immediately before `wipefs`. Removable drives are still offered (some thin clients expose
  internal eMMC as removable) but are sorted last and labelled `REMOVABLE DRIVE` in the wizard.
- **Dual Bootloader Deployment:** Automatically installs both **UEFI** (`x86_64-efi` with removable fallback `BOOTX64.EFI`) and **Legacy BIOS** (`i386-pc`) bootloaders, ensuring the hard drive boots on any virtual machine (Hyper-V Gen 1/2, VirtualBox) or physical PC.
- **100% RAM Overlay on Disk:** Configures `/etc/overlayroot.conf` with `overlayroot="tmpfs"` on the installed drive, guaranteeing zero flash storage wear and clean resets on reboot even after permanent installation. The `LABKIOSK_DATA` partition above is the deliberate exception.
- **Decoupled Transfer:** Transfers rootfs files via `rsync` without premature submounts, preventing filesystem deadlock errors (`EBUSY 16`).

---

## 📁 Directory Structure

```text
distro-builder/
├── AGENTS.md                           # AI Agent architecture codex for Distro Builder
├── Dockerfile                          # Containerized cross-platform ISO builder
├── docker-build.sh                     # In-container build steps (the Dockerfile's CMD)
├── build-iso.sh                        # Native Debian/Ubuntu/WSL2 build script
├── auto/                               # live-build automation scripts (config, build, clean)
├── config/
│   ├── bootloaders/                    # ISOLINUX (BIOS) and GRUB EFI (UEFI) configs & graphics
│   ├── package-lists/
│   │   └── kiosk.list.chroot           # Minimal Debian package manifest (Xorg, Openbox, Chromium, rsync, parted, efibootmgr)
│   ├── hooks/live/
│   │   ├── 01-lockdown.hook.chroot     # User locking, TTY masking, polkit policies, autologin
│   │   └── 02-security.hook.chroot     # Kernel sysctl hardening, GRUB password enforcement
│   └── includes.chroot/                # Filesystem overlay injected into live and installed image
│       ├── etc/
│       │   ├── chromium/policies/      # Managed enterprise policies (URLBlocklist, URLAllowlist)
│       │   ├── openbox/                # Locked rc.xml and autostart script
│       │   ├── overlayroot.conf        # tmpfs RAM overlay configuration
│       │   └── systemd/system/         # cloudflared-kiosk.service (the only unit shipped here)
│       ├── opt/labkiosk/
│       │   ├── setup/                  # First-boot onboarding & disk installation HTML wizard
│       │   ├── extension/              # Manifest V3 extension (content.js, background.js, manifest.json)
│       │   └── agent/                  # Python 3 telemetry daemon (agent.py)
│       ├── usr/local/bin/
│       │   └── labkiosk-install        # Automated Python hard disk installer
│       └── usr/share/labkiosk/
│           ├── chromium-policy-base.json # THE single declaration of the static Chromium policy
│           ├── cloudflared.pin         # Pinned release version & SHA-256 for cloudflared binary
│           └── grub.pin                # Pinned PBKDF2 hash for GRUB boot password
├── tools/
│   └── generate-chromium-policy.py     # Regenerates the boot-time policy from the base (--check in CI)
└── out/                                # Generated ISO and SHA-256 artifacts
```

---

## 🔨 Building the Kiosk ISO

### Method 1: Using Docker (Cross-Platform: Windows, macOS, Linux)

No local Linux installation or package dependencies required. Run both commands from the
**repository root**:

```bash
# Build the builder container image
docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder

# Run live-build in privileged container and mount output directory
docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" ghcr.io/akbhoi/labkiosk-iso-builder
```

The output image `labkiosk-debian12-amd64.iso` and its SHA-256 checksum file are generated in `distro-builder/out/`.

#### Building your own changes vs. pulling the published builder

The builder image **contains the source**: its `Dockerfile` does `COPY . /build/`, rather than
bind-mounting the tree, because Windows 9P/drvfs mounts break `mknod`. That makes the distinction
below important.

| Goal | Command |
| :--- | :--- |
| **Build the ISO from your working tree** (what you want while developing) | `docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder` first, as above |
| **Reproduce the published ISO** exactly as CI builds it from `main` | `docker pull ghcr.io/akbhoi/labkiosk-iso-builder:latest`, then run it |

A *pulled* builder produces an ISO from the source baked into that image at publish time — **not**
from your local edits. Rebuild the image after every change to `distro-builder/`.

> [!IMPORTANT]
> **The container engine must be rootful.** `live-build` runs `debootstrap`, which creates device
> nodes with `mknod` — and a *rootless* user namespace forbids that even under `--privileged`, so
> the build fails partway through the chroot stage. Docker Desktop is rootful by default. If your
> `docker` command is served by a podman machine, switch it once:
>
> ```bash
> podman machine stop && podman machine set --rootful && podman machine start
> ```
>
> Verify before starting a long build:
>
> ```bash
> docker run --rm --privileged debian:bookworm-slim sh -c 'mknod /tmp/n b 7 99 && echo ok'
> ```
>
> Note that rootful and rootless keep **separate image stores**, so images you pulled before the
> switch will not be listed afterwards. Reverse it any time with `podman machine set --rootful=false`.
>
> [!NOTE]
> Only `distro-builder/out/` is bind-mounted. The source is copied into the image by the
> `Dockerfile` rather than mounted, because Windows 9P/drvfs bind mounts enforce `nodev`/`noexec`
> and would break `mknod` inside the build.

### Method 2: Native Linux / WSL2

On a Debian 12 (Bookworm) or Ubuntu 22.04+ host:

```bash
# Install live-build dependencies
sudo apt-get update && sudo apt-get install -y live-build debootstrap

# Run build script
cd distro-builder
sudo bash build-iso.sh
```

---

## 🔒 Securing the Boot Chain

Hardened kiosk configurations (masked TTYs, disabled VT switching, locked desktop) depend upon an untampered kernel invocation. If GRUB is left unsecured, an attacker with physical access could edit kernel parameters (e.g., append `init=/bin/sh`) to obtain an unrestricted root shell.

### 1. The GRUB Boot-Menu Password

**The workstation always boots completely unattended.** Every menu entry is marked
`--unrestricted` (applied unconditionally by `02-security.hook.chroot`), so powering on goes
straight to the kiosk with no prompt. The password is asked for only when someone presses `e` to
edit an entry or `c` for the GRUB shell.

> [!IMPORTANT]
> **Do not commit a hash for an image you ship to more than one customer.** A hash compiled into
> the ISO is one boot-menu password shared by every deployment that image produced: a leak at any
> single site compromises all of them, it cannot be rotated on machines already in the field, and
> `grub.pin` is tracked in git, so the hash is permanent in history and open to offline cracking
> by anyone who can read the repository. Use Route 1 below instead.

#### Route 1 — per installation (the default; nothing to configure)

The setup wizard's **Install to Hard Disk** step collects a boot-menu password and derives the
PBKDF2 hash **in the browser** with WebCrypto, posting only the digest. The plaintext therefore
never reaches the agent's API, never appears in a process argument, and is never written to disk.
`labkiosk-install` writes `/etc/grub.d/01_labkiosk_password` on the target before `update-grub`.

Each site — or each workstation, if you prefer — gets its own password, and the shipped ISO
carries no secret at all. Use the wizard's **Generate** button for a random 20-character password,
and record it before installing: it cannot be recovered afterwards.

#### Route 2 — per-customer ISO (also locks the live USB menu)

Supply the hash in the build environment rather than committing it:

```bash
docker run --rm -it ghcr.io/akbhoi/labkiosk-iso-builder grub-mkpasswd-pbkdf2 -c 200000
```

```bash
docker run --privileged --rm -e LABKIOSK_GRUB_PBKDF2="grub.pbkdf2.sha512.200000.YOUR.HASH" -v "$PWD/distro-builder/out:/build/out" ghcr.io/akbhoi/labkiosk-iso-builder
```

`LABKIOSK_GRUB_PBKDF2` takes precedence over `grub.pin`. The `grub.pin` file remains as a
fallback for a single organisation building an image for its own lab.

#### Where each mechanism applies

| Target | Mechanism | Set by |
| :--- | :--- | :--- |
| **Installed disk** | `/etc/grub.d/01_labkiosk_password`, consumed by `update-grub` | The wizard, per installation (Route 1) |
| **Live ISO, UEFI** | `config/bootloaders/grub-pc/labkiosk-password.cfg`, sourced by `config.cfg` | `auto/config` from `LABKIOSK_GRUB_PBKDF2` or `grub.pin` (Route 2) |
| **Live ISO, legacy BIOS** | `ALLOWOPTIONS 0` + `NOESCAPE 1` in `config/bootloaders/*/stdmenu.cfg` — **no password needed**: syslinux discards any kernel argument the user types | static config, always |

- With no hash supplied the build prints a note and produces an editable **live** menu. That is
  the correct default for a shipped product, because installed workstations get their password
  from Route 1.
- If a hash is supplied but is not a `grub.pbkdf2.sha512.` value, the build **fails** rather than
  shipping an image whose menu is unprotected in a way nobody noticed.

### 2. BIOS / UEFI Hardening

After flashing the OS to the target workstation:

1. Enter the workstation BIOS/UEFI firmware setup.
2. Set a strong Supervisor/Administrator BIOS password.
3. Configure the internal storage or dedicated boot USB as the primary boot target.
4. Disable alternate boot device selection (F12 boot menu) and unauthorized USB booting.

---

## 💾 Flashing to USB Storage

Write the compiled ISO to a USB flash drive (minimum 2 GB):

- **Windows:** Use **Rufus**. Select the target drive, choose the ISO, and ensure **DD Image mode** is selected when prompted.
- **macOS / Linux:** Use **balenaEtcher** or standard `dd`:

  ```bash
  sudo dd if=distro-builder/out/labkiosk-debian12-amd64.iso of=/dev/sdX bs=4M status=progress conv=fsync
  ```

---

## 📦 Cloudflared Binary Pinning

To support remote desktop supervision via Cloudflare Tunnel:

1. Update `distro-builder/config/includes.chroot/usr/share/labkiosk/cloudflared.pin` with the desired release tag and SHA-256 hash.
2. The build script verifies the binary's checksum during image creation.
3. If unpinned or mismatched, the build fails closed to prevent unverified binaries from entering the OS.
