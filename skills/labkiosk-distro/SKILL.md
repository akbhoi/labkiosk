---
name: labkiosk-distro
description: Engineering, debugging, and verification procedures for the LabKiosk Debian 12 Live Operating System, containerized live-build ISO pipeline, hybrid BIOS/UEFI bootloaders, automated hard disk installer, local Python agent daemon, and Manifest V3 browser extension. Use when modifying distro packages, bootloader configs, install scripts, agent routes, or testing on VMs/Docker.
---

# Lab Kiosk Distro Builder & Client OS Engineering Skill

This skill guides AI coding assistants through modifying, building, debugging, and verifying the **Debian 12 Client Operating System**, live-build ISO builder, automated disk installer, and local workstation software.

> **Architecture Reference:** Read [`distro-builder/AGENTS.md`](../../distro-builder/AGENTS.md) before making architectural changes.

---

## 1. Operating Procedures

### A. Modifying the Client Agent (`agent.py`)
1. File: `distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py`.
2. **Loopback Only:** Local API binds strictly to `127.0.0.1:8888`. All state mutations (`/api/install`, `/api/reboot`, `/api/setup`, `/api/network/configure`, `/api/admin/verify`) MUST check `_is_local_caller()` to block cross-origin requests. Besides loopback it accepts exactly one origin, `KIOSK_EXTENSION_ORIGIN` — the extension's service worker, whose non-`GET` fetches Chromium stamps with `chrome-extension://<id>`. Keep it matched to the literal id, never to the scheme.
3. **Session Awareness (`is_live_session()`):**
   - Returns `True` if running on live media (USB/ISO).
   - Returns `False` if running on an installed disk.
   - `/api/status` reports `isLive`, `isInstalled`, and `isOnline`.
   - `/api/install` and `/api/install/disks` are locked out when `not is_live_session()`.
4. **Network Subsystem:**
   - Detects interfaces via `nmcli dev status` (`/api/network/interfaces`).
   - Scans Wi-Fi SSIDs with signal bars, security flags, and hidden SSID support (`/api/network/wifi/scan`).
   - Configures Ethernet & Wi-Fi with DHCP, Custom DNS, or Static IP (IPv4 & IPv6), plus optional HTTP proxy (`/api/network/configure`). An empty Wi-Fi password keeps the passphrase already saved for that SSID.
   - Reports the saved profile back as `profile` in `/api/network/status` (per-family mode, address, gateway, DNS, SSID, adapter) so the wizard can show the settings in force.
   - Verifies route reachability (`/api/network/test`, cached 5s in `test_connectivity()`).
   - Serves the tail of `/tmp/lab-agent.log` over `/api/log` (admin token required once installed): the workstation has no terminal, so the setup wizard's diagnostics panel is the only way to read it.
   - Verifies admin passwords against GRUB PBKDF2 hash (`/api/admin/verify`) and issues a 10-minute token; `/api/network/configure` requires it (`X-LabKiosk-Admin`) on installed systems. Five failures lock the gate for 60 s.
5. **Syntax Verification:**
   ```bash
   PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
   ```

### B. Modifying the Automated Disk Installer (`labkiosk-install`)
1. File: `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`.
2. **Standard Output Rule:** All log messages, execution traces, and warnings MUST print to `file=sys.stderr`. `sys.stdout` is reserved exclusively for JSON strings (`--list-disks` and `--status`).
3. **Hybrid Partitioning (BIOS + UEFI):**
   - Partition 1: `bios_grub` (1MiB - 2MiB, flag `bios_grub on`) for legacy GRUB embedding on GPT.
   - Partition 2: `ESP` (2MiB - 514MiB, FAT32, flag `esp on`) for UEFI boot files.
   - Partition 3: `ROOT` (514MiB - end − 513MiB, ext4, label `LABKIOSK_ROOT`) for root filesystem.
   - Partition 4: `DATA` (end − 512MiB - 100%, ext4, label `LABKIOSK_DATA`) mounted at `/etc/labkiosk` with `nofail`.
4. **Data Partition Ownership and Persistence:** `/etc/labkiosk` (the `LABKIOSK_DATA` mount) must
   be owned by the `kiosk` user, because the agent writes `config.json` there unprivileged at
   enrolment. The installer chowns it and then verifies with `runuser -u kiosk -- touch`, failing
   the install if not; `labkiosk-data-permissions.service` re-checks at every boot.
   `system-connections` stays root-only. That service must also **mount** the partition when the
   boot has not (the fstab entry is `nofail`, so nothing waits for it) and must never create a
   plain directory in its place: that would accept the enrolment into the RAM overlay and lose it
   at the next power-off. The agent's `enrolment_is_persistent()` reports the same state as
   `persistentStorage` in `/api/status` and `persistent` in the enrolment reply, and it checks the
   *filesystem type* at `/etc/labkiosk`, not merely that something is mounted there — an overlay
   or a tmpfs is a mount and is still RAM.
   The matching boot-side rule: `overlayroot="tmpfs:recurse=0"`. Written any other way (an
   `overlayroot_options=` line is read by nothing) overlayroot defaults to `recurse=1` and overlays
   every fstab entry, the data partition included.
5. **Network Configuration Persistence:**
   - Installer copies NetworkManager connection keyfiles to `/mnt/target_kiosk/etc/labkiosk/system-connections/` (mode `0600`).
   - Adds `/etc/fstab` bind mount: `/etc/labkiosk/system-connections /etc/NetworkManager/system-connections none bind,nofail 0 0`.
   - Carries `proxy.json` onto `LABKIOSK_DATA` with the rest of `/etc/labkiosk`. It does **not** write `/etc/environment`: the agent applies the proxy at start, and a copy on the read-only root could never be switched off.
6. **Mount Sequencing Rule:**
   - Mount only `part_root` during `rsync`.
   - Never use `--delete` when copying into a fresh filesystem.
   - Mount `part_esp` to `/boot/efi` **only after** `rsync` completes to avoid `EBUSY (16)` errors.
7. **Dual Bootloader Installation:**
   - UEFI: `grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=LabKiosk --recheck`
   - UEFI Removable Fallback: `grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable --recheck`
   - BIOS: `grub-install --target=i386-pc <disk> --recheck`
8. **Boot-Menu Password (`--grub-password-hash`):**
   - Applied per installation, derived in the browser (SHA-512, 200,000 rounds, 64-byte salt) and posted only as a digest.
   - Validated against `GRUB_PBKDF2_PATTERN`.
9. **Syntax Verification:**
   ```bash
   PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
   ```

### B1. Language & Region (`labkiosk-localization`)
1. File: `distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-localization`, the only
   program the agent may run through `sudo` (`/etc/sudoers.d/51-labkiosk-localization`).
2. **Re-validate everything**: timezone against `/usr/share/zoneinfo` *and* tzdata's zone table,
   locale against `/usr/share/i18n/SUPPORTED`, keyboard layout against the X11 rules list, clock
   against a plausible year range. The agent is not a trust boundary.
3. `--list-options` is read-only and needs no privileges; the agent calls it directly to build the
   wizard's menus. `--root <dir>` applies to an installer target instead of the running system.
4. Three spellings of a locale exist — `en_IN`, `en_IN.UTF-8` and `en_IN.utf8` — and
   `canonical_locale()`/`locale_key()` normalise them. Compare with those, never with `==`.
5. `timedatectl`, `localectl`, `hwclock` and `setxkbmap` are all optional in practice (absent in
   the simulator, absent in a target root, or present with no X session). A missing one must read
   as "declined", never as a crash: that is what `run(..., check=False)` is for.
6. Syntax check:
   ```bash
   PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-localization
   ```

### B2. Timezone
`Asia/Kolkata` (IST), and it has to be set in **two** places or the live session and the installed
disk will disagree: `/etc/localtime` + `/etc/timezone` in `01-lockdown.hook.chroot` (what an
installed workstation keeps), and `timezone=Asia/Kolkata` on every live boot entry — both
`--bootappend-*` lines in `auto/config` plus the hardcoded failsafe entry in the `isolinux`,
`syslinux` and `grub-pc` menus. live-config's `0070-tzdata` rewrites the zone on every live boot
and falls back to `Etc/UTC` without that parameter. The simulator and ISO-builder images set `TZ`
and `/etc/localtime` in their Dockerfiles; `docker-compose.yml` lets `TZ` be overridden per
deployment.

### C. Modifying the Browser Extension (MV3)
1. Directory: `distro-builder/config/includes.chroot/opt/labkiosk/extension/`.
2. Architecture:
   - `content.js`: Renders navigation bar, `#btn-network` status indicator, admin verification modal, and lock curtain inside a **Shadow DOM**. Redirects to `/setup#offline` if offline for more than 6 s on an external, unlocked page. Reveals the bar for 2.5 s on the first page of each session (`labkiosk:intro-peek`), because an auto-hiding bar is otherwise undiscoverable.
   - `background.js`: Service worker with `host_permissions` for `http://127.0.0.1:8888/*`. Handles `labkiosk:verify-admin` and `labkiosk:network-status`.
3. Syntax Verification:
   ```bash
   node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
   node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
   ```

### D. Modifying the Setup & Installation Wizard (`wizard.html`)
1. File: `distro-builder/config/includes.chroot/opt/labkiosk/setup/wizard.html`.
2. **Sequential Stepper Workflow:**
   - `Step 1: Network Setup`: Ethernet & Wi-Fi scanning, IPv4/IPv6 (DHCP, Custom DNS, Static IP), and Proxy configuration.
   - `Step 2: Destination Mode`: Choose between "Install to Hard Disk" or "Live Preview & Temporary Enrollment".
   - **Installed workstations skip Step 1 entirely** and open on enrolment; `#network` (top-bar icon or offline fallback) is the only way back to the network page, and it prompts for the administrator / boot password.
   - The network form is pre-filled from `profile` in `/api/network/status`, and the addressing accordion opens by itself when anything is not on automatic.

---

## 2. Compiling & Verifying the ISO Image

### Containerized Build via Docker
Run from the repository root:
```bash
# 1. Rebuild the builder image (the Dockerfile copies the working tree into the image)
docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder

# 2. Compile the live ISO into distro-builder/out/
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


### Output Artifacts
- Path: `distro-builder/out/labkiosk-debian12-amd64.iso`
- Checksum: `distro-builder/out/labkiosk-debian12-amd64.iso.sha256`

---

## 3. Testing Matrix

| Environment | Test Target | Verification Steps |
| :--- | :--- | :--- |
| **Hyper-V (Gen 2 - UEFI)** | Bootloader, Live Session, Disk Install | Verify GRUB EFI menu card, direct boot into desktop, disk detection, clean installation to VHDX, and standalone reboot. |
| **VirtualBox (Default - BIOS)** | Bootloader, Live Session, Disk Install | Verify ISOLINUX menu card, direct boot into desktop, installation to VDI, and legacy GRUB boot. |
| **Docker Simulator** | Agent, Extension, Telemetry | Rapid testing via `docker cp` and visual screen capture via `scrot`. |
