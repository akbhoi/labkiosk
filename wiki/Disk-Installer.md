# Disk Installer

`distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install` — a self-contained Python 3 installer that copies the live medium's system image to an internal drive with a hybrid GPT layout that boots on both BIOS and UEFI machines. The installed drive is an image store, the first step of over-the-air updates ([docs/OTA_UPDATES.md](../docs/OTA_UPDATES.md) §5.1).

It is normally driven from the setup wizard's **Install to Hard Disk** tab, but it can be run directly from a terminal. `/etc/sudoers.d/50-labkiosk-install` grants the `kiosk` user one `NOPASSWD` sudo rule for exactly this binary, and nothing else.

---

## Flags

| Flag | Purpose |
| :--- | :--- |
| `--list-disks` | Emits candidate target disks as JSON on stdout |
| `--status` | Reads `/tmp/labkiosk-install-status.json`; returns state and progress percentage |
| `--target /dev/sdX` | Runs the full partition → format → image copy → GRUB sequence as root |
| `--grub-password-hash <grub.pbkdf2.sha512…>` | Optional, with `--target`. Gives this installation its own boot-menu password |

---

## Partition layout

The installer writes a **hybrid GPT** layout so one disk image boots on legacy BIOS machines, UEFI-only laptops, and Hyper-V Gen 2 alike.

| # | Name | Range | Filesystem | Purpose |
| :-- | :--- | :--- | :--- | :--- |
| 1 | `bios_grub` | 1 MiB – 2 MiB | none, flag `bios_grub on` | Lets legacy GRUB embed `core.img` on a GPT disk |
| 2 | `ESP` | 2 MiB – 514 MiB | FAT32, flag `esp on` | UEFI bootloader files |
| 3 | `ROOT` | 514 MiB – (end − 513 MiB) | ext4, label `LABKIOSK_ROOT` | The immutable Debian 12 system |
| 4 | `DATA` | last 512 MiB | ext4, label `LABKIOSK_DATA` | Mounted at `/etc/labkiosk` with `nofail` |

### Why partition 4 exists

`overlayroot="tmpfs"` is configured on the installed drive too, so every write on a running workstation lands in RAM and is discarded at power-off. That is the point — but it also means a workstation enrolled *after* installation would forget its device token on the next reboot, and any configured Wi-Fi credentials or static IP settings would be lost.

`LABKIOSK_DATA` is the single deliberate exception. It holds:

1. `/etc/labkiosk/config.json` — device bearer token, client ID, and worker URL.
2. `/etc/labkiosk/proxy.json` — organization proxy settings.
3. `/etc/labkiosk/system-connections/` — NetworkManager connection profiles, bind-mounted to `/etc/NetworkManager/system-connections` on boot.

Everything else on an installed machine, `/etc/machine-id` and browser cache included, is regenerated or reset on every boot.

### Negative parted offsets need `--`

ROOT and DATA are sized from the end of the disk (`-513MiB`, `-512MiB`). Without a `--` separator, parted parses those as bundled single-letter options and aborts the install.

---

## Disk selection

`--list-disks` enumerates candidate block devices of at least 7 GiB (a drive sold as 8 GB qualifies; two system images fit side by side), preferring `lsblk -J` and falling back to `/sys/block` sysfs enumeration when `lsblk` is unavailable or returns nothing.

**The disk backing the live medium is excluded.** `live_medium_disks()` matches `/proc/mounts` against `/run/live/medium` and friends, resolves each to its parent disk through `/sys`, and drops it from the list — *and* rejects it again immediately before `wipefs`. Before this, one click could repartition the USB stick the installer was running from.

Removable drives are **not** hidden, because internal eMMC on some thin clients reports as removable. They sort last and the wizard labels them `REMOVABLE DRIVE`, so the default selection is always an internal disk.

---

## The install sequence

```text
 1. Re-validate --target against TARGET_DISK_PATTERN
 2. Reject the disk backing the live medium (second check) and a disk under 7 GiB
 3. Find the system image (live/{vmlinuz,initrd.img,filesystem.squashfs} on the medium), its
    version (/usr/share/labkiosk/version), the grub.cfg template and labkiosk-boot-slots
    -- all before anything is erased
 4. wipefs, then parted: GPT + the four partitions above
 5. mkfs.fat -F32 on ESP, mkfs.ext4 on ROOT and DATA
 6. mount ROOT, ESP and DATA at three separate directories
 7. copy the image to ROOT/images/<version>/, fsync each file
 8. carry network profiles, config.json, proxy.json and localization.json onto DATA; prove kiosk can write it
 9. grub-install x86_64-efi, x86_64-efi --removable, i386-pc, all with --boot-directory=ROOT/boot
10. copy usr/share/labkiosk/boot/grub.cfg to ROOT/boot/grub/, write labkiosk-password.cfg if a hash was supplied
11. labkiosk-boot-slots init <version>: grubenv with current=<version>
```

Nothing is written into the system image: an update replaces it whole. What used to be written onto the
root filesystem moved (OTA §5.2): `/etc/fstab` became `etc-labkiosk.mount` and a bind-mount unit in the
image, `/etc/labkiosk-installed` became `labkiosk.installed=1` on the command line, the boot password moved
to `boot/grub/`, and language and region are re-applied by the agent from `localization.json` at every start.

### Booting the image

The installed `grub.cfg` boots `images/<current>/` through live-boot, exactly as the ISO boots, with
`labkiosk.installed=1 noeject panic=10` and no `timezone=`. A new image gets exactly one try (`next`,
`next_tries=1` in `grubenv`); GRUB spends the try before booting it, so a failure of any kind ends with the
old image. `labkiosk-boot-ok.service` confirms the new image once the agent and the browser have stayed up
for a minute, or reboots into the old one. Details: `distro-builder/AGENTS.md` Rule 8.

### Three GRUB installs, deliberately

| Command | Covers |
| :--- | :--- |
| `grub-install --target=x86_64-efi --efi-directory=<ESP> --boot-directory=<ROOT>/boot --bootloader-id=LabKiosk --no-nvram --recheck` | Normal UEFI boot entry |
| `grub-install --target=x86_64-efi --efi-directory=<ESP> --boot-directory=<ROOT>/boot --removable --recheck` | `EFI/BOOT/BOOTX64.EFI` fallback, for firmware that loses NVRAM boot variables |
| `grub-install --target=i386-pc --boot-directory=<ROOT>/boot <disk> --recheck` | Legacy BIOS, embedding into the `bios_grub` partition |

All three run on every install, so the drive boots regardless of the machine's firmware mode.

---

## Boot-menu password

The password is applied **per installation**, never baked into the ISO. A hash compiled into an image is one password shared by every customer that image was shipped to: unrotatable in the field, and permanent in git history.

**How it flows:**

1. The wizard's install step collects a password and derives the PBKDF2 digest **in the browser** with WebCrypto (SHA-512, 200 000 rounds, 64-byte salt).
2. Only the digest is posted to `POST /api/install` as `grubPasswordHash`. The plaintext never crosses the agent's API, never appears in a process argument, and is never written to disk.
3. Both `agent.py` and `labkiosk-install` validate it against an identical `GRUB_PBKDF2_PATTERN`.
4. `labkiosk-install` writes `boot/grub/labkiosk-password.cfg` on ROOT, outside every system image, so updates keep it. The installed `grub.cfg` sources it, and the agent reads it to check the administrator password.

When the flag is omitted, no password file is written, so an unlocked install is visibly unlocked rather than silently carrying the shipping image's secret.

Use the wizard's **Generate** button for a random 20-character password, and record it before installing — it cannot be recovered afterwards.

### Booting still never prompts

Every entry in the installed `grub.cfg` is `--unrestricted`, **unconditionally** (a test checks it). It is a no-op without `superusers`, but since the password now usually arrives at install time, making it conditional would give an installed disk `set superusers` with no unrestricted entry — and every workstation would stop at a password prompt on every boot instead of coming up into the kiosk.

The password is asked for only when someone presses `e` to edit an entry or `c` for the GRUB shell.

→ [Kiosk Hardening](Kiosk-Hardening#securing-the-boot-chain)

---

## Implementation standards

These are enforced because each one caused a real failure:

1. **Zero stdout pollution.** All logging, traces, and warnings go to `file=sys.stderr`. `sys.stdout` carries valid JSON only. When `[INSTALL] Executing: …` was printed to stdout, `agent.py` failed with `JSONDecodeError` and the wizard reported *"no candidate internal drives detected"*.
2. **Kernel fallback.** If `lsblk -J` is missing or returns an empty list, fall back to `/sys/block`.
3. **Empty machine-id** in the image (the lockdown hook empties it), so every boot generates its own.
4. **`--` before negative parted offsets**, per the partition table above.
5. **Target re-validation inside the installer.** `--target` is checked against `TARGET_DISK_PATTERN` here, not only by the agent. The sudoers rule lets `kiosk` invoke this binary directly, so the caller is not a trust boundary.

---

## Live-session lockout

`is_live_session()` is implemented identically in the installer and the agent:

| Signal | Verdict |
| :--- | :--- |
| `labkiosk.installed=1` on the kernel command line (or `/etc/labkiosk-installed`, on a disk installed before the image store) | Installed drive, checked first |
| otherwise `/run/live` exists, or `boot=live` in `/proc/cmdline` | Live installer |

On an installed system, `/api/install/disks` returns `[]` and `POST /api/install` is refused with `400 System is already installed on an internal drive`. A misdirected click cannot destroy the running system.

---

## Syntax check

```bash
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
```

→ [Installation Guide](Installation-Guide) · [Building the ISO](Building-the-ISO) · [Client Agent](Client-Agent)
