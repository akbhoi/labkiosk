# Client Kiosk OS & ISO Distro Builder

[← Back to Documentation Hub](../README.md#documentation-hub)

A minimal, security-hardened Debian 12 (Bookworm) live kiosk operating system designed for educational computer labs and thin-client workstations.

---

## 🌟 Architecture & Operating System Design

The Lab Kiosk operating system is built specifically for resource-constrained thin clients (e.g., Intel Celeron/Pentium, 4 GB RAM, 12 GB SATA SSD) with an immutable, zero-wear storage model.

### 1. 100% RAM Overlay (`toram` + `overlayroot="tmpfs"`)
- At boot time, the entire operating system image is copied from the bootable medium into RAM (`toram` kernel boot parameter).
- The root filesystem is mounted strictly read-only (`ro`).
- Dynamic runtime file system writes (browser cache, agent logs, temporary downloads, student session state) are diverted to a `tmpfs` RAM disk via `overlayroot`.
- **Zero SSD Wear Guarantee:** Thin-client flash storage is never written to during operation, eliminating drive exhaustion and wear cycles.
- On reboot or power-off, all student session state, cached files, and temporary artifacts vanish instantly.

### 2. Hardened Operating System Lockdown
- **TTY & Console Masking:** Virtual consoles `tty1` through `tty6` are masked in systemd. VT switching is disabled at the X server level via `DontVTSwitch` and `DontZap` options in `/etc/X11/xorg.conf.d/10-lockdown.conf`.
- **Stripped Window Manager:** Openbox runs with an empty keybinding table in `/etc/openbox/rc.xml`. Shortcuts such as `Alt+Tab`, `Alt+F4`, `Ctrl+Alt+Del`, and custom key sequences are completely inert.
- **Account Restrictions:** The default `kiosk` user has no sudo rights and a locked password; the `root` account is disabled.
- **Polkit Power Policy:** Shutdown and reboot via systemd/D-Bus are restricted to authorized administrators or remote commands dispatched by the teacher.

### 3. Chromium Enterprise Kiosk & Manifest V3 Extension
- **Top-Level Native Browsing:** External educational platforms (Khan Academy, YouTube, Scratch) enforce strict `X-Frame-Options` and `frame-ancestors` headers. Lab Kiosk loads all web destinations as native top-level pages, avoiding iframe embedding limitations.
- **Auto-Hiding Navigation Bar:** An unpacked Manifest V3 Chromium extension injects an auto-hiding 44px navigation bar into top-level pages inside a Shadow DOM.
  - Controls: Home, Back, Forward, Reload, and Status Shield.
  - Behavior: Auto-hides via `transform: translateY(-100%)` and smoothly transitions into view only when the mouse cursor enters the top 12 pixels (`mouseY <= 12px`).
  - Viewport: Occupies 100% of the viewport with `0px` vertical scroll overflow without mutating `document.body.style.marginTop`.
- **Lock Curtain ("Eyes to the Front"):** Full-screen DOM overlay displayed across all open tabs upon teacher command. Swallows keyboard and mouse input events and displays customized teacher announcements.
- **Extension Communication Architecture:**
  - `content.js` runs in the page context inside an isolated Shadow DOM. It **never** fetches from the local agent directly (which would require unsafe wildcard CORS).
  - `content.js` messages `background.js` (MV3 service worker) via `chrome.runtime.sendMessage`.
  - `background.js` owns the `host_permissions` grant for `http://127.0.0.1:8888/*` and communicates with the local agent daemon.
- **No Blanket Extension Block:** The enterprise policy deliberately avoids `ExtensionInstallBlocklist: ["*"]`, which would prevent loading unpacked extensions via `--load-extension`. Student extensions remain blocked because `chrome://` is blocked, Chrome Web Store is not allowlisted, and browser profiles are wiped on launch.

### 4. Local Python 3 Daemon (`agent.py`)
- Resides at `/opt/labkiosk/agent/agent.py` and runs as a background systemd service (`labkiosk-agent.service`).
- **Telemetry Loop (Every 3s):** Authenticates to the Cloudflare control plane using a stored bearer device token, transmits screen thumbnails (scrot compressed via PIL JPEG, max 256 KB), receives pending teacher commands, and checks broadcast status.
- **Dynamic Policy Synchronization:** Writes the tenant's approved domain allowlist into `/etc/chromium/policies/managed/policies.json`.
- **Loopback API:** Binds strictly to `127.0.0.1:8888` to serve the first-boot onboarding wizard and health probes.
- **Session State Awareness:** Distinguishes between live evaluation sessions (`boot=live` on USB/ISO) and permanent disk installations.

### 5. Automated Hard Disk Installer (`labkiosk-install`)
- Resides at `/usr/local/bin/labkiosk-install` and can be invoked directly from the terminal or via the Setup Wizard GUI.
- **Universal Hybrid GPT Partitioning:**
  1. `bios_grub` (1 MiB – 2 MiB): Enables legacy BIOS GRUB embedding on GPT partitioned disks.
  2. `ESP` (2 MiB – 514 MiB, FAT32): Holds the UEFI bootloader and configuration.
  3. `ROOT` (514 MiB – 100%, ext4): Stores the immutable Debian 12 operating system.
- **Dual Bootloader Deployment:** Automatically installs both **UEFI** (`x86_64-efi` with removable fallback `BOOTX64.EFI`) and **Legacy BIOS** (`i386-pc`) bootloaders, ensuring the hard drive boots on any virtual machine (Hyper-V Gen 1/2, VirtualBox) or physical PC.
- **100% RAM Overlay on Disk:** Configures `/etc/overlayroot.conf` with `overlayroot="tmpfs"` on the installed drive, guaranteeing zero flash storage wear and clean resets on reboot even after permanent installation.
- **Decoupled Transfer:** Transfers rootfs files via `rsync` without premature submounts, preventing filesystem deadlock errors (`EBUSY 16`).

---

## 📁 Directory Structure

```text
distro-builder/
├── AGENTS.md                           # AI Agent architecture codex for Distro Builder
├── Dockerfile                          # Containerized cross-platform ISO builder
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
│       │   └── systemd/system/         # Service definitions (labkiosk-agent, websockify, cloudflared)
│       ├── opt/labkiosk/
│       │   ├── setup/                  # First-boot onboarding & disk installation HTML wizard
│       │   ├── extension/              # Manifest V3 extension (content.js, background.js, manifest.json)
│       │   └── agent/                  # Python 3 telemetry daemon (agent.py)
│       ├── usr/local/bin/
│       │   └── labkiosk-install        # Automated Python hard disk installer
│       └── usr/share/labkiosk/
│           ├── cloudflared.pin         # Pinned release version & SHA-256 for cloudflared binary
│           └── grub.pin                # Pinned PBKDF2 hash for GRUB boot password
└── out/                                # Generated ISO and SHA-256 artifacts
```

---

## 🔨 Building the Kiosk ISO

### Method 1: Using Docker (Cross-Platform: Windows, macOS, Linux)
No local Linux installation or package dependencies required:
```bash
# Build the builder container image
docker build -t labkiosk-iso-builder distro-builder

# Run live-build in privileged container and mount output directory
docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" labkiosk-iso-builder
```
The output image `labkiosk-debian12-amd64.iso` and its SHA-256 checksum file are generated in `distro-builder/out/`.

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

### 1. Pinning the GRUB PBKDF2 Password
Before building the ISO, generate a GRUB PBKDF2 password hash:
```bash
grub-mkpasswd-pbkdf2
```
Copy the resulting output (format: `grub.pbkdf2.sha512.10000...`) into:
`distro-builder/config/includes.chroot/usr/share/labkiosk/grub.pin`:
```ini
PASSWORD_PBKDF2=grub.pbkdf2.sha512.10000.YOUR_GENERATED_HASH_HERE
```
- The live build hook reads `grub.pin` and automatically configures `/etc/grub.d/40_custom` with password protection.
- Default boot entries load automatically without prompting for a password.
- Editing boot entries or entering the GRUB command shell requires administrative authentication.
- If `grub.pin` is left empty, the build prints a warning and proceeds with an unlocked menu (suitable for testing in VMs, but unacceptable for production classrooms).

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
