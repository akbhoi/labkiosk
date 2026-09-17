# Disk Installer

`distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install` — a self-contained Python 3 installer that writes the live image to an internal drive with a hybrid GPT layout that boots on both BIOS and UEFI machines.

It is normally driven from the setup wizard's **Install to Hard Disk** tab, but it can be run directly from a terminal. `/etc/sudoers.d/50-labkiosk-install` grants the `kiosk` user one `NOPASSWD` sudo rule for exactly this binary, and nothing else.

---

## Flags

| Flag | Purpose |
| :--- | :--- |
| `--list-disks` | Emits candidate target disks as JSON on stdout |
| `--status` | Reads `/tmp/labkiosk-install-status.json`; returns state and progress percentage |
| `--target /dev/sdX` | Runs the full partition → format → rsync → GRUB sequence as root |
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

`overlayroot="tmpfs"` is configured on the installed drive too, so every write on a running workstation lands in RAM and is discarded at power-off. That is the point — but it also means a workstation enrolled *after* installation would forget its device token on the next reboot.

`LABKIOSK_DATA` is the single deliberate exception. It holds `/etc/labkiosk/config.json` and nothing else. Everything else on an installed machine, `/etc/machine-id` included, is regenerated every boot.

> On an image built before this partition existed, enrol from the **live session before installing**, so the token is copied across with the rootfs.

### Negative parted offsets need `--`

ROOT and DATA are sized from the end of the disk (`-513MiB`, `-512MiB`). Without a `--` separator, parted parses those as bundled single-letter options and aborts the install.

---

## Disk selection

`--list-disks` enumerates candidate block devices of at least 3 GB, preferring `lsblk -J` and falling back to `/sys/block` sysfs enumeration when `lsblk` is unavailable or returns nothing.

**The disk backing the live medium is excluded.** `live_medium_disks()` matches `/proc/mounts` against `/run/live/medium` and friends, resolves each to its parent disk through `/sys`, and drops it from the list — *and* rejects it again immediately before `wipefs`. Before this, one click could repartition the USB stick the installer was running from.

Removable drives are **not** hidden, because internal eMMC on some thin clients reports as removable. They sort last and the wizard labels them `REMOVABLE DRIVE`, so the default selection is always an internal disk.

---

## The install sequence

```text
 1. Re-validate --target against TARGET_DISK_PATTERN
 2. Reject the disk backing the live medium (second check)
 3. wipefs, then parted: GPT + the four partitions above
 4. mkfs.fat -F32 on ESP, mkfs.ext4 on ROOT and DATA
 5. mount ONLY part_root at /mnt/target_kiosk
 6. rsync the live rootfs across        <-- no --delete, no submounts
 7. mount part_esp at /mnt/target_kiosk/boot/efi   <-- only now
 8. truncate /etc/machine-id to a genuinely empty file
 9. write /etc/fstab, /etc/overlayroot.conf, /etc/labkiosk-installed
10. write /etc/grub.d/01_labkiosk_password if a hash was supplied
11. grub-install x86_64-efi, then x86_64-efi --removable, then i386-pc
12. update-grub
```

### Step 5–7: the mount sequencing rule

This ordering is not cosmetic. Mounting the ESP at `/boot/efi` *before* `rsync --delete` runs produces:

```text
rsync: delete_file: rmdir(boot/efi) failed: Device or resource busy (16) (code 23)
```

So: **mount only `part_root` during `rsync`; never pass `--delete` into a freshly formatted filesystem; mount `part_esp` at `/boot/efi` only after `rsync` completes.**

### Step 8: the machine-id marker

`/etc/machine-id` is truncated to a genuinely **empty** file. That is the marker systemd reads as "uninitialised" and replaces on first boot. A file containing anything else — a bare newline included — is not that marker, and every installed workstation would share one machine ID.

### Step 11: three GRUB installs, deliberately

| Command | Covers |
| :--- | :--- |
| `grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=LabKiosk --recheck` | Normal UEFI boot entry |
| `grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable --recheck` | `/boot/efi/EFI/BOOT/BOOTX64.EFI` fallback, for firmware that loses NVRAM boot variables |
| `grub-install --target=i386-pc <disk> --recheck` | Legacy BIOS, embedding into the `bios_grub` partition |

All three run on every install, so the drive boots regardless of the machine's firmware mode.

---

## Boot-menu password

The password is applied **per installation**, never baked into the ISO. A hash compiled into an image is one password shared by every customer that image was shipped to: unrotatable in the field, and permanent in git history.

**How it flows:**

1. The wizard's install step collects a password and derives the PBKDF2 digest **in the browser** with WebCrypto (SHA-512, 200 000 rounds, 64-byte salt).
2. Only the digest is posted to `POST /api/install` as `grubPasswordHash`. The plaintext never crosses the agent's API, never appears in a process argument, and is never written to disk.
3. Both `agent.py` and `labkiosk-install` validate it against an identical `GRUB_PBKDF2_PATTERN`.
4. `labkiosk-install` writes `/etc/grub.d/01_labkiosk_password` on the target before `update-grub`.

When the flag is omitted, any password inherited from the live medium is **removed**, so an unlocked install is visibly unlocked rather than silently carrying the shipping image's secret.

Use the wizard's **Generate** button for a random 20-character password, and record it before installing — it cannot be recovered afterwards.

### Booting still never prompts

`02-security.hook.chroot` marks every generated menu entry `--unrestricted`, **unconditionally**. It is a no-op without `superusers`, but since the password now usually arrives at install time, making it conditional would give an installed disk `set superusers` with no unrestricted entry — and every workstation would stop at a password prompt on every boot instead of coming up into the kiosk.

The password is asked for only when someone presses `e` to edit an entry or `c` for the GRUB shell.

→ [Kiosk Hardening](Kiosk-Hardening#securing-the-boot-chain)

---

## Implementation standards

These are enforced because each one caused a real failure:

1. **Zero stdout pollution.** All logging, traces, and warnings go to `file=sys.stderr`. `sys.stdout` carries valid JSON only. When `[INSTALL] Executing: …` was printed to stdout, `agent.py` failed with `JSONDecodeError` and the wizard reported *"no candidate internal drives detected"*.
2. **Kernel fallback.** If `lsblk -J` is missing or returns an empty list, fall back to `/sys/block`.
3. **Empty machine-id**, per step 8 above.
4. **`--` before negative parted offsets**, per the partition table above.
5. **Target re-validation inside the installer.** `--target` is checked against `TARGET_DISK_PATTERN` here, not only by the agent. The sudoers rule lets `kiosk` invoke this binary directly, so the caller is not a trust boundary.

---

## Live-session lockout

`is_live_session()` is implemented identically in the installer and the agent:

| Signal | Verdict |
| :--- | :--- |
| `/etc/labkiosk-installed` exists | Installed drive |
| `/run/live` exists, or `boot=live` in `/proc/cmdline` | Live installer |

On an installed system, `/api/install/disks` returns `[]` and `POST /api/install` is refused with `400 System is already installed on an internal drive`. A misdirected click cannot destroy the running system.

---

## Syntax check

```bash
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
```

→ [Installation Guide](Installation-Guide) · [Building the ISO](Building-the-ISO) · [Client Agent](Client-Agent)
