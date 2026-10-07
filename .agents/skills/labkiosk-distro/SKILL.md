---
name: labkiosk-distro
description: Lab Kiosk Debian 12 image and installation — live-build ISO pipeline (distro-builder/auto, Dockerfile), package list, hooks, Chromium managed policy, overlayroot RAM overlay and the LABKIOSK_DATA partition, BIOS+UEFI bootloaders, boot-menu password, timezone defaults, and the disk installer (labkiosk-install). Use when changing how the image is built, booted or installed, or when building/testing an ISO; use labkiosk-client for the agent, extension and wizard.
---

# Lab Kiosk — image build, boot & installer

Paths are under `distro-builder/`. Authoritative detail: `distro-builder/AGENTS.md` Rules 1–3, §3–5.

## Image invariants

- **RAM overlay**: `overlayroot="tmpfs:recurse=0"` — exactly that spelling, in
  `/etc/overlayroot.conf`, the installer's output and every boot command line. An
  `overlayroot_options=` line is read by nothing; at the default `recurse=1` even `/etc/labkiosk`
  becomes RAM and enrolments vanish at power-off. Root stays read-only; `toram` is an opt-in menu
  entry, not the default.
- **`LABKIOSK_DATA` at `/etc/labkiosk`** is the only persistent path on an installed disk. It must be
  owned by `kiosk` (installer chowns and proves it with `runuser -u kiosk -- touch`;
  `labkiosk-data-permissions.service` re-checks every boot, mounts it if needed, and **never
  fabricates a directory** in its place). `system-connections/` inside stays root-only.
- **Only what the package list names** (`config/package-lists/kiosk.list.chroot`; recommends and
  firmware defaults are off). Keep `live-tools` + `eject`, `locales`, `tzdata`, `xkb-data`. The image
  has no noVNC, websockify or cloudflared (Remote Control goes through the console's relay); the
  simulator's noVNC comes from `docker-test/novnc.pin` + `docker-test/install-novnc.sh`, never
  Debian's `novnc`. Never `x11-xserver-utils`.
- **Pins fail closed**: `grub.pin` (stays empty — the
  boot password is applied per installation). Never invent a checksum to make a build pass.
- **Boot never prompts**: `02-security.hook.chroot` marks every entry `--unrestricted`
  unconditionally.
- **Timezone set twice**: `Asia/Kolkata` default in `01-lockdown.hook.chroot` *and*
  `timezone=Asia/Kolkata` on both `--bootappend-*` lines in `auto/config` plus the hardcoded failsafe
  entries in `isolinux`, `syslinux`, `grub-pc`. The wizard's Language & Region step is what an
  organization actually uses.
- **Chromium policy** is generated from `usr/share/labkiosk/chromium-policy-base.json`; never edit
  `etc/chromium/policies/managed/policies.json` by hand. No blanket `ExtensionInstallBlocklist`
  (it kills the kiosk extension). Never `--disable-web-security`.
- **LF endings** on every hook/script/config (`.gitattributes`); a CRLF hook dies with
  `$'\r': command not found`.

## Installer (`config/includes.chroot/usr/local/bin/labkiosk-install`)

- `sys.stdout` carries **only JSON** (`--list-disks`, `--status`); all logging to `sys.stderr`.
- GPT: `bios_grub` 1–2 MiB · ESP 2–514 MiB FAT32 · ROOT ext4 to end−513 MiB · DATA ext4 last 512 MiB.
  Negative parted offsets need `--`. Minimum disk 7 GiB (a drive sold as 8 GB): two images.
- **ROOT is an image store, not a root filesystem** (`docs/OTA_UPDATES.md` §5.1, codex Rules 3 and 8):
  `boot/grub/{grub.cfg,grubenv,labkiosk-password.cfg,labkiosk-data.cfg}` and `images/<version>/{vmlinuz,initrd.img,
  filesystem.squashfs}` copied from the live medium, version from `usr/share/labkiosk/version`
  (equal to `AGENT_VERSION`; a test checks). Locate everything **before** `wipefs`.
- The installed disk boots through live-boot with `labkiosk.installed=1 noeject panic=10` and no
  `timezone=`; `grub.cfg` is `usr/share/labkiosk/boot/grub.cfg` verbatim, every entry
  `--unrestricted`. One try for `next`, rollback by GRUB; `labkiosk-boot-ok.service`
  (`labkiosk-boot-slots check`) confirms or reboots. Nothing may be written into an image after
  installation: per-machine state goes on DATA or in `boot/grub/`.
- Install **both** bootloaders from the live session with `--boot-directory=<ROOT>/boot`:
  `grub-install --target=x86_64-efi --efi-directory=<ESP> --bootloader-id=LabKiosk --no-nvram`,
  the same with `--removable` (firmware that loses NVRAM), and `grub-install --target=i386-pc <disk>`.
- Exclude the disk backing the live medium (`live_medium_disks()`), re-checked before `wipefs`.
- Re-validate `--target` (`TARGET_DISK_PATTERN`) and `--grub-password-hash` (`GRUB_PBKDF2_PATTERN`)
  inside the installer — sudoers lets `kiosk` run it directly. The image ships an empty
  `/etc/machine-id` (lockdown hook).
- Carries NetworkManager keyfiles (to `/mnt/target_kiosk/etc/labkiosk/system-connections/`, mode
  0600, dir 0700; the image's bind mount unit puts them over
  `/etc/NetworkManager/system-connections`), `proxy.json` and `localization.json` onto DATA;
  never writes `/etc/environment`. Seeding DATA copies regular files only (never through a symlink,
  never a directory) and drops setuid/setgid/sticky bits.
- `etc-labkiosk.mount` (`nofail`) replaces the fstab. It is generated by
  `labkiosk-data-generator` from `labkiosk.data=<uuid>` (the installer's `labkiosk-data.cfg`);
  never by label, which a USB stick can claim.
- live-config runs on installed disks too: its `sudo` and `policykit` components stay pre-seeded
  away in the lockdown hook, or `kiosk` gets passwordless root.

## Image slots (`config/includes.chroot/usr/local/sbin/labkiosk-boot-slots`, root only)

- `check` (from `labkiosk-boot-ok.service`) promotes a trial image once agent and browser stay up
  60 s within a 600 s deadline, else reboots into `current`; `status`, `try VERSION`, `init VERSION`.
  It writes `/run/labkiosk-update/status.json`, which the agent reports to the Worker
  (`labkiosk-core` §2b). The health check talks to the loopback agent with no proxy, ever.
- The installed kiosk has no shell (getty masked, no SSH). To test a slot by hand, mount
  LABKIOSK_ROOT from elsewhere and `grub-editenv boot/grub/grubenv set next=X next_tries=1`.
- `labkiosk-update download URL | install VERSION | status` (root only, phase 2) is run by hand:
  gpgv against `usr/share/labkiosk/update-keys/*.gpg`, the floor in `usr/share/labkiosk/security-floor`,
  downloads in `downloads/<v>/`, renamed into `images/<v>/` only once verified. Never write a
  download inside `images/` (GRUB's last resort boots any complete folder there). The build
  fails without two public keys in `update-keys/`. Tests: `tests/test_update.py`, boot-test
  scenarios 5–9. Phases 3–5 (automatic trigger, approval UI, LAN sharing) are research, not code.

## Build the ISO

```bash
docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder   # always, after any change: the source is COPYed in
docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" ghcr.io/akbhoi/labkiosk-iso-builder
```

- The engine must be **rootful** (`debootstrap` needs `mknod`). This machine's `docker` is a
  rootful podman machine; use plain `docker` commands. Check:
  `docker run --rm --privileged debian:bookworm-slim sh -c 'mknod /tmp/n b 7 99 && echo ok'`.
- Only `out/` is bind-mounted (Windows 9P mounts break `mknod`); `.dockerignore` keeps stale
  `chroot/`, `cache/` and `config/binary` out.
- Before building, delete any `__pycache__` under `config/includes.chroot` — live-build copies it
  into the image. Always compile/test with `PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc`.
- Output: `distro-builder/out/labkiosk-debian12-amd64.iso` (+ `.sha256`).

## When it does not work

| Symptom | Cause → fix |
|---|---|
| No nav bar or lock curtain; "Loading of unpacked extensions is disabled" | A blanket `ExtensionInstallBlocklist` → remove it. |
| A Chromium allowlist entry is ignored ("Invalid pattern") | `http://localhost:*` / `127.0.0.1:*` are invalid → write `localhost`, `127.0.0.1` (no port matches all ports). |
| `$'\r': command not found` in a hook | CRLF endings → `.gitattributes` `eol=lf`; rewrite the file with LF. |
| Installed machine reboots into the installer | `live-tools`/`eject` missing from the package list. |
| Enrolment forgotten after reboot, no error | `recurse=0` misspelled, or DATA not mounted → see Image invariants; `persistentStorage` in `/api/status` says which. |
| Black screen at boot | `quiet loglevel=3` / locked autologin → `consoleblank=0`, `passwd -d kiosk`. |
| Installed machine stops at "Please remove the live-medium … press ENTER" on reboot | `noeject` missing from the installed `grub.cfg` command line. |
| `'en-US' is not a language tag` while installing | A `\\Z` anchor in a raw string → fixed; rebuild the ISO. |

## Test matrix

| Where | What |
|---|---|
| Hyper-V Gen 2 (UEFI) | GRUB EFI menu, live boot, disk detection, install to VHDX, standalone reboot. The host is reachable at the Default Switch address (e.g. `172.31.64.1`) for a local Worker. |
| VirtualBox (BIOS) | ISOLINUX menu, install to VDI, legacy GRUB boot |
| Docker simulator | agent, extension, telemetry — see `labkiosk-simulator` |
| Build ISO workflow (KVM) | `tests/vm/boot-test.sh` (run by `.github/workflows/build-iso.yml` after each build): the ISO's own installer onto a virtual disk, then promote, broken squashfs, recover and unhealthy image in QEMU + OVMF. UEFI only; BIOS is covered by the GRUB menu tests. Needs root and `/dev/kvm`, so not on Windows. |

```bash
python3 distro-builder/tools/generate-chromium-policy.py --check
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-boot-slots
sh -n distro-builder/config/includes.chroot/etc/systemd/system-generators/labkiosk-data-generator
bash -n distro-builder/auto/config   # and any hook you touched
```
