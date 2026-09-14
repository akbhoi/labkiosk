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
   python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
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
   python3 -m py_compile distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
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

### Containerized Build via Podman (WSL2 / Linux)
```bash
# 1. Rebuild the builder container image (copies working directory into Linux ext4)
wsl -d podman-machine-default -u root podman build -t labkiosk-iso-builder /mnt/d/Projects/AntigravityProjects/labkiosk/distro-builder

# 2. Compile live ISO image into output directory
wsl -d podman-machine-default -u root podman run --privileged --rm -v /mnt/d/Projects/AntigravityProjects/labkiosk/distro-builder/out:/build/out:z labkiosk-iso-builder
```

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
