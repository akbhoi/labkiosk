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
│                                       #   plus the cloudflared.pin & grub.pin build pins
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
- Thin-client SSDs and flash storage (as small as 12 GB, with limited write cycles) are protected from flash degradation.
- The underlying root filesystem **must remain mounted read-only (`ro`)**.
- All dynamic filesystem writes (browser cache, agent logs, temporary downloads, student sessions) divert strictly to `tmpfs` in RAM.
- On reboot or power loss, 100% of runtime changes and student artifacts vanish instantly.

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
| **Kiosk nav bar and lock curtain vanish** | Blanket extension block `ExtensionInstallBlocklist: ["*"]` prevents loading unpacked extensions. | Do not add blanket extension blocks. Chromium is already locked down via `--kiosk`, blocked `chrome://`, and wiped user profile. |
| **Freshly enrolled kiosk shows "This page is blocked"** | Chromium reads its managed policy once at startup. | Agent sets `pendingBrowserRestart` and restarts the browser after the next policy sync. |
| **A shell hook dies with `$'\r': command not found`** | The file was checked out or written with CRLF line endings. Windows git defaults to `core.autocrlf=true`, and Python's `Path.write_text` translates newlines on Windows. | `.gitattributes` pins every build and image file to `eol=lf`. Never write these files with a tool that rewrites newlines. |
| **Enrolment on an installed workstation is forgotten after a reboot** | `overlayroot="tmpfs"` sends every write to a RAM overlay, `/etc/labkiosk/config.json` included. | The installer creates the `LABKIOSK_DATA` partition and mounts it at `/etc/labkiosk`. On an image built before that change, enrol from the live session *before* installing. |
| **Installer offers the USB it booted from** | `--list-disks` recorded the `removable` flag but never filtered on it. | `live_medium_disks()` excludes the backing disk of `/run/live/medium`, both when listing and again immediately before `wipefs`. |
| **Black screen on boot (Plymouth/NODM deadlock)** | `quiet loglevel=3` suppressed boot logs and PAM autologin was locked. | Pass `consoleblank=0` (remove `quiet loglevel=3`), unlock kiosk password (`passwd -d kiosk`), and pre-seed live-config markers. |
