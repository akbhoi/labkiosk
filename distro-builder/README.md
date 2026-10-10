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
  `kiosk` holds exactly two sudo grants, `NOPASSWD` on `/usr/local/bin/labkiosk-install`
  (`/etc/sudoers.d/50-labkiosk-install`), which is what lets the setup wizard run the guided disk
  installer, and on `/usr/local/sbin/labkiosk-localization` (`51-labkiosk-localization`) for the
  Language & Region step. Both re-validate every argument. There is no general sudo access:
  live-config's `sudo` and `policykit` components are pre-seeded away, and
  `labkiosk-boot-slots` has no sudo rule, so the agent never chooses which image boots.
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
- **Control Channel:** One WebSocket to the organization's OrgHub (`/api/devices/ws`), falling back
  to the 3-second HTTP heartbeat (`POST /api/telemetry`) when that is unavailable. Authenticates to
  the Cloudflare control plane with a stored bearer device token, transmits a screen thumbnail
  (over the WebSocket only while an operator is watching; with every HTTP heartbeat), receives pending operator commands, and checks
  broadcast status. The thumbnail is produced by `scrot -t 20 -q 35` — pure Python standard
  library plus `scrot`, with **no PIL/Pillow dependency** — and a frame whose base64 payload
  exceeds 256 KB (`MAX_THUMBNAIL_BYTES`) is dropped rather than sent, so an oversized capture
  never costs the organization's uplink or delays the heartbeat.
- **Local API:** threaded (`ThreadingHTTPServer`), so a slow call such as the disk scan cannot
  stall the once-a-second status poll that drives the lock curtain.
- **Dynamic Policy Synchronization:** Writes the tenant's approved domain allowlist into `/etc/chromium/policies/managed/policies.json`.
- **Loopback API:** Binds strictly to `127.0.0.1:8888` to serve the first-boot onboarding wizard and health probes.
- **Session State Awareness:** Distinguishes between live evaluation sessions (`boot=live` on USB/ISO) and permanent disk installations (`labkiosk.installed=1` on the kernel command line, checked first because an installed disk boots through live-boot too).
- **Boot Reports:** On an installed disk the agent forwards the outcome `labkiosk-boot-slots` recorded in `/run/labkiosk-update/status.json` (`installed`, `failed`, `rolled-back`, `fallback`, `error`) to `POST /api/devices/boot-report`; problems appear in the console under **Settings → Errors & Warnings**.

### 5. Automated Hard Disk Installer (`labkiosk-install`)

- Resides at `/usr/local/bin/labkiosk-install` and can be invoked directly from the terminal or via the Setup Wizard GUI.
- **Universal Hybrid GPT Partitioning:**
  1. `bios_grub` (1 MiB – 2 MiB): Enables legacy BIOS GRUB embedding on GPT partitioned disks.
  2. `ESP` (2 MiB – 514 MiB, FAT32): Holds the UEFI bootloader and configuration.
  3. `ROOT` (514 MiB – 513 MiB from the end, ext4, label `LABKIOSK_ROOT`): the image store —
     `boot/grub/` (`grub.cfg`, `grubenv`, `labkiosk-password.cfg`, `labkiosk-data.cfg`) and whole
     system images in `images/<version>/` (`vmlinuz`, `initrd.img`, `filesystem.squashfs`).
  4. `DATA` (last 512 MiB, ext4, label `LABKIOSK_DATA`): mounted at `/etc/labkiosk` with `nofail`,
     **by UUID, never by label** (GRUB passes `labkiosk.data=<uuid>` from `boot/grub/labkiosk-data.cfg`
     and `labkiosk-data-generator` turns it into `etc-labkiosk.mount`; no `/etc/fstab` is written).
     This is the **only** part of an installed machine that survives a reboot, and it exists so
     that a workstation enrolled *after* installation stays enrolled — every other write goes to
     the RAM overlay and is discarded at power-off.
- **Minimum Disk Size:** 7 GiB, so that two system images fit side by side (a drive sold as 8 GB qualifies).
- **Refuses to erase the medium it is running from:** candidate disks are matched against the
  device backing `/run/live/medium`, and that disk is excluded from the list *and* rejected again
  immediately before `wipefs`. Removable drives are still offered (some thin clients expose
  internal eMMC as removable) but are sorted last and labelled `REMOVABLE DRIVE` in the wizard.
- **Dual Bootloader Deployment:** Automatically installs both **UEFI** (`x86_64-efi` with removable fallback `BOOTX64.EFI`) and **Legacy BIOS** (`i386-pc`) bootloaders, ensuring the hard drive boots on any virtual machine (Hyper-V Gen 1/2, VirtualBox) or physical PC.
- **100% RAM Overlay on Disk:** The installed drive boots its image through live-boot exactly like the ISO (`labkiosk.installed=1 noeject panic=10` on the command line), so the squashfs is the read-only lower layer and every write goes to RAM, guaranteeing zero flash storage wear and clean resets on reboot even after permanent installation. The `LABKIOSK_DATA` partition above is the deliberate exception; nothing is written into a system image after installation.
- **Image Store:** Copies the live medium's system image (squashfs, kernel, initrd) to `images/<version>/` (the version from `/usr/share/labkiosk/version`) instead of copying a root filesystem, installs the shared `usr/share/labkiosk/boot/grub.cfg` verbatim, and runs `grub-install` with `--boot-directory` on `ROOT`. Everything is located before `wipefs`, so a medium that cannot produce a bootable disk fails before the disk is erased.
- **One-Try Boot & Rollback:** `boot/grub/grubenv` holds `current`, `previous`, `next` and `next_tries`. GRUB spends the try before booting `next`, and any failure falls back to `current`. `labkiosk-boot-ok.service` runs `labkiosk-boot-slots check` at every installed boot: it confirms a new image once the agent and browser have stayed up for a minute, and otherwise reboots into the old one. `labkiosk-boot-slots` (root only) also offers `status`, `try VERSION` and `init VERSION`. To test a slot on a kiosk with no shell, mount `LABKIOSK_ROOT` elsewhere and run `grub-editenv boot/grub/grubenv set next=VERSION next_tries=1`.
- **Signed Downloads (run by hand):** `labkiosk-update download URL` fetches a signed release (see [Over-the-air releases](#-over-the-air-releases)), verifies its manifest with `gpgv` against the keys in `/usr/share/labkiosk/update-keys/`, refuses anything below `/usr/share/labkiosk/security-floor`, and resumes an interrupted download chunk by chunk. It downloads into `downloads/<version>/` and moves the folder into `images/` only once every file is verified; `labkiosk-update install VERSION` then gives it the one try. In normal use the console drives it (`labkiosk-update run` and `install-pending`, phase 3 of `docs/OTA_UPDATES.md`), and a security release for the line the workstation runs is given its one try at the next start without approval (phase 4). LAN sharing is phase 5.
- **Boot Test in CI:** `.github/workflows/build-iso.yml` runs `tests/vm/boot-test.sh` (QEMU, OVMF, KVM) after every ISO build: install, promotion, a broken squashfs, recovery and an unhealthy image. It needs root and `/dev/kvm`, so it does not run on Windows; legacy BIOS boot is covered only by the GRUB menu tests.

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
│       │   ├── systemd/system/         # labkiosk-boot-ok.service
│       │   └── systemd/system-generators/ # labkiosk-data-generator (DATA mount by UUID)
│       ├── opt/labkiosk/
│       │   ├── setup/                  # First-boot onboarding & disk installation HTML wizard
│       │   ├── extension/              # Manifest V3 extension (content.js, background.js, manifest.json)
│       │   └── agent/                  # Python 3 telemetry daemon (agent.py)
│       ├── usr/local/bin/
│       │   ├── labkiosk-install        # Automated Python hard disk installer (image store, dual GRUB)
│       │   └── labkiosk-lock-keys      # Strips blocked keys from the X keymap
│       ├── usr/local/sbin/
│       │   ├── labkiosk-boot-slots     # Root-only: grubenv, one-try boot, health check, rollback
│       │   └── labkiosk-localization   # Timezone, locale and keyboard (sudo; re-validates every argument)
│       └── usr/share/labkiosk/
│           ├── boot/grub.cfg           # Every installed disk's boot menu, copied verbatim
│           ├── chromium-policy-base.json # THE single declaration of the static Chromium policy
│           ├── grub.pin                # Pinned PBKDF2 hash for GRUB boot password
│           └── version                 # The image's release (= AGENT_VERSION)
├── tests/
│   ├── test_client.py                  # Client unit tests (python3 -m unittest discover)
│   └── vm/boot-test.sh                 # QEMU install, promotion and rollback test (CI, needs KVM)
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

## 📡 Over-the-air releases

Every tagged release is also an over-the-air update. After the boot test passes, `build-iso.yml` extracts `live/` from the ISO, writes `manifest.json` with `tools/make-release-manifest.py` (size, sha256 and 8 MiB chunk hashes of `vmlinuz`, `initrd.img` and `filesystem.squashfs`, plus the version and the security floor), signs it, checks the signature against the keys the image carries, and uploads the five files to R2 under `releases/<version>/`. A version already in R2 is never overwritten.

It needs, before the first tag:

| Where | Name | What |
| :--- | :--- | :--- |
| Repository | `config/includes.chroot/usr/share/labkiosk/update-keys/current.gpg`, `next.gpg` | The release-signing public keys. **The ISO build fails without both.** How to make them: [`update-keys/README.md`](config/includes.chroot/usr/share/labkiosk/update-keys/README.md) |
| Actions secret | `UPDATE_SIGNING_KEY` | The armored secret key matching `current.gpg` |
| Actions secret | `UPDATE_SIGNING_PASSPHRASE` | Its passphrase, if it has one |
| Actions secret | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | An R2 API token with Object Read & Write on the releases bucket |
| Actions secret | `CLOUDFLARE_ACCOUNT_ID` | Already set for the Worker deploy; it names the R2 endpoint |
| Actions variable | `R2_RELEASES_BUCKET` | The R2 bucket the releases go to |
| Actions secret | `RELEASE_NOTES_TOKEN` | The same value as the Worker secret of that name: after publishing, the build asks the controller to read the release in, so `/download` offers it at once ([`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md#release-notes-on-download)) |
| Actions variable | `CONTROLLER_URL` | The controller's `https://` address, e.g. `https://labkiosk.org` |

A tag must equal `usr/share/labkiosk/version`; a pre-release tag (`v2.7.0-rc1`) is published on the `beta` channel, any other on `stable`. When a release fixes a security hole, raise `usr/share/labkiosk/security-floor` to its version: workstations running it then refuse every older release, however validly signed.

**Security rebuilds.** `security-rebuild.yml` runs every day at 06:00 IST (and by hand, with a line, a `force` and a `dry_run` switch). For the latest two release lines from 2.9 on, it reads the installed packages of each line's newest release from its published ISO and compares them with Debian's `bookworm-security` archive (`tools/security-rebuild.py check`). When one has a fix, it rebuilds that tag's own source with only its version raised one patch (`2.9.0` → `2.9.1`, in the four files that carry it), refuses the result if it still lacks a fix the archive has, runs that release's boot test, signs it as `kind: security` with `baseVersion` set, uploads it to R2, pushes the tag (on a commit no branch carries), and publishes the GitHub release with the changed packages as its notes. It uses the same secrets and variables as above. A super admin then classifies it on the Releases page like any release; workstations on that line install it at their next start unless their organization approves security releases.

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
`labkiosk-install` writes `boot/grub/labkiosk-password.cfg` on the installed disk's image store, which its `grub.cfg` sources.

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
| **Installed disk** | `boot/grub/labkiosk-password.cfg` on `LABKIOSK_ROOT`, sourced by the installed `grub.cfg` | The wizard, per installation (Route 1) |
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
