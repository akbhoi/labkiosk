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
2. **Loopback Only:** Local API binds strictly to `127.0.0.1:8888`. All state mutations (`/api/install`, `/api/reboot`, `/api/setup`) MUST check `_is_local_caller()` to block cross-origin requests.
3. **Session Awareness (`is_live_session()`):**
   - Returns `True` if running on live media (USB/ISO).
   - Returns `False` if running on an installed disk.
   - `/api/status` reports `isLive` and `isInstalled`.
   - `/api/install` and `/api/install/disks` are locked out when `not is_live_session()`.
4. **Syntax Verification:**
   ```bash
   PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
   ```

### B. Modifying the Automated Disk Installer (`labkiosk-install`)
1. File: `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`.
2. **Standard Output Rule:** All log messages, execution traces, and warnings MUST print to `file=sys.stderr`. `sys.stdout` is reserved exclusively for JSON strings (`--list-disks` and `--status`).
3. **Hybrid Partitioning (BIOS + UEFI):**
   - Partition 1: `bios_grub` (1MiB - 2MiB, flag `bios_grub on`) for legacy GRUB embedding on GPT.
   - Partition 2: `ESP` (2MiB - 514MiB, FAT32, flag `esp on`) for UEFI boot files.
   - Partition 3: `ROOT` (514MiB - 100%, ext4, label `LABKIOSK_ROOT`) for root filesystem.
4. **Mount Sequencing Rule:**
   - Mount only `part_root` during `rsync`.
   - Never use `--delete` when copying into a fresh filesystem.
   - Mount `part_esp` to `/boot/efi` **only after** `rsync` completes to avoid `EBUSY (16)` errors.
5. **Dual Bootloader Installation:**
   - UEFI: `grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=LabKiosk --recheck`
   - UEFI Removable Fallback: `grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable --recheck`
   - BIOS: `grub-install --target=i386-pc <disk> --recheck`
6. **Syntax Verification:**
   ```bash
   PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
   ```

### C. Modifying the Browser Extension (MV3)
1. Directory: `distro-builder/config/includes.chroot/opt/labkiosk/extension/`.
2. Architecture:
   - `content.js`: Renders navigation bar and lock curtain inside a **Shadow DOM**. Never calls loopback API directly.
   - `background.js`: Service worker with `host_permissions` for `http://127.0.0.1:8888/*`. Acts as the exclusive bridge between content script and agent.
3. Syntax Verification:
   ```bash
   node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
   node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
   ```

### D. Modifying the Setup & Installation Wizard (`wizard.html`)
1. File: `distro-builder/config/includes.chroot/opt/labkiosk/setup/wizard.html`.
2. **Dynamic UI Handling:**
   - Tabs `#tabs-nav` default to `style="display: none;"`.
   - `loadAgentStatus()` checks `data.isLive`:
     - If live: Shows `#tabs-nav` (`display: flex`) with badge `LIVE INSTALLER & SETUP`.
     - If installed: Hides `#tabs-nav`, hides disk installer, presents enrollment form, badge `INSTALLED WORKSTATION ENROLLMENT`.

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
