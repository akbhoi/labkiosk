# LabKiosk Distro Builder & Client OS — AI Agent Codex

> **Scope:** This document is the authoritative architectural specification and coding standard for the **Debian 12 Live Kiosk Operating System**, containerized ISO build pipeline, local Python agent daemon, automated hard disk installer, and Chromium Manifest V3 extension.
> For the Cloudflare edge SaaS control plane, refer to [`cloudflare-control/AGENTS.md`](../cloudflare-control/AGENTS.md). For master cross-cutting contracts, refer to the root [`AGENTS.md`](../AGENTS.md).

---

## 1. System Architecture Map

```text
distro-builder/
├── Dockerfile                          # Containerized cross-platform live-build environment
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
│       │   └── systemd/system/         # Systemd units (NODM, kiosk autostart)
│       ├── opt/labkiosk/
│       │   ├── setup/wizard.html       # Setup & Enrollment Wizard GUI (HTML/JS)
│       │   ├── extension/              # Manifest V3: content.js (top bar & curtain) +
│       │   │                           #   background.js (service worker; sole loopback caller)
│       │   └── agent/agent.py          # Python 3 telemetry daemon & local loopback API
│       ├── usr/local/bin/
│       │   └── labkiosk-install        # Automated Python disk installer (GPT, ESP, ext4, dual GRUB)
│       └── usr/share/labkiosk/         # Cryptographic pins: cloudflared.pin & grub.pin
└── out/                                # Generated ISO & SHA-256 artifacts
```

---

## 2. Invariant Rules for Client Distro & Installer

### Rule 1: 100% RAM Overlay Protection (`overlayroot="tmpfs"`)
- The client OS runs as an **immutable system copied into RAM** (`toram` on live media, `overlayroot="tmpfs"` on internal drives).
- Thin-client SSDs and flash storage (as small as 12 GB, with limited write cycles) are protected from flash degradation.
- The underlying root filesystem **must remain mounted read-only (`ro`)**.
- All dynamic filesystem writes (browser cache, agent logs, temporary downloads, student sessions) divert strictly to `tmpfs` in RAM.
- On reboot or power loss, 100% of runtime changes and student artifacts vanish instantly.

### Rule 2: Universal Dual Bootloader Compatibility (BIOS + UEFI)
- Workstations in school environments range from legacy BIOS machines to modern UEFI-only hardware (e.g. Hyper-V Gen 2, modern laptops/NUCs).
- **ISO Boot:**
  - BIOS boots via **ISOLINUX** (`distro-builder/config/bootloaders/isolinux/`).
  - UEFI boots via **GRUB EFI** (`distro-builder/config/bootloaders/grub-pc/`).
- **Disk Installation:**
  - The installer partitions target drives with a **Hybrid GPT layout**:
    1. Partition 1: `bios_grub` (1 MiB – 2 MiB, flag `bios_grub on`) for legacy GRUB `i386-pc` MBR embedding on GPT.
    2. Partition 2: `ESP` (2 MiB – 514 MiB, FAT32, flag `esp on`) for UEFI bootloader files.
    3. Partition 3: `ROOT` (514 MiB – 100%, ext4, label `LABKIOSK_ROOT`) for the operating system.
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
  - Live session: Shows `#tabs-nav` (`1. Connect & Enroll` and `2. Install to Hard Disk`) with badge `LIVE INSTALLER & SETUP`.
  - Installed drive: Completely hides `#tabs-nav`, hides the disk installer view, presents the enrollment form directly, and displays badge `INSTALLED WORKSTATION ENROLLMENT`.
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
- All mutating endpoints (`/api/install`, `/api/reboot`, `/api/setup`) reject requests whose `Origin` header is not loopback (`127.0.0.1` or `localhost`).
- Telemetry transmitted upstream to Cloudflare is authenticated with the workstation's device token.

---

## 3. Automated Local Disk Installer (`labkiosk-install`)

Located at `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`.

### Execution Flags:
- `--list-disks`: Scans candidate non-removable physical/virtual block devices (>= 3 GB). Returns pure JSON to `sys.stdout`.
- `--status`: Reads `/tmp/labkiosk-install-status.json` and returns current installation state and progress percentage.
- `--target /dev/sdX`: Runs full partition, format, rootfs rsync, and GRUB deployment as root.

### Critical Implementation Standards:
1. **Zero Stdout Pollution**: All logging, traces, and debugging strings MUST write to `file=sys.stderr`. `sys.stdout` must strictly contain valid JSON so agent parsing cannot fail with `JSONDecodeError`.
2. **Kernel Fallback**: If `lsblk -J` is unavailable or returns an empty list, the installer falls back to `/sys/block` sysfs enumeration.
3. **Machine ID Reset**: The installer truncates `/etc/machine-id` on the target rootfs so systemd generates a fresh, unique machine-id on first boot of the installed system.

---

## 4. Verification & Testing Playbook

### 1. Client Syntax Validation
Always run before packaging or testing:
```bash
python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
python3 -m py_compile distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
```

### 2. Containerized ISO Build (Podman / Docker)
Run via native Podman (in WSL2 or Linux):
```bash
# Step 1: Build the builder container image (copies source into native Linux ext4)
wsl -d podman-machine-default -u root podman build -t labkiosk-iso-builder /mnt/d/Projects/AntigravityProjects/labkiosk/distro-builder

# Step 2: Run live-build in privileged container and mount output directory
wsl -d podman-machine-default -u root podman run --privileged --rm -v /mnt/d/Projects/AntigravityProjects/labkiosk/distro-builder/out:/build/out:z labkiosk-iso-builder
```
*Note: Never bind-mount the source tree directly over `/build` in the container on Windows, because Windows 9P/drvfs mounts enforce `nodev`/`noexec` and break `mknod`.*

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
| **Kiosk nav bar and lock curtain vanish** | Blanket extension block `ExtensionInstallBlocklist: ["*"]` prevents loading unpacked extensions. | Do not add blanket extension blocks. Chromium is already locked down via `--kiosk`, blocked `chrome://`, and wiped user profile. |
| **Freshly enrolled kiosk shows "This page is blocked"** | Chromium reads its managed policy once at startup. | Agent sets `pendingBrowserRestart` and restarts the browser after the next policy sync. |
| **Black screen on boot (Plymouth/NODM deadlock)** | `quiet loglevel=3` suppressed boot logs and PAM autologin was locked. | Pass `consoleblank=0` (remove `quiet loglevel=3`), unlock kiosk password (`passwd -d kiosk`), and pre-seed live-config markers. |
