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
| `--hostname <name>` | Optional, with `--target`. The workstation's hostname; generated when absent ([Hostname](#hostname)) |
| `--dual-boot` | Optional, with `--target`. Install beside the disk's other system, into its largest free space ([Beside another system](#beside-another-system-dual-boot)) |
| `--replace-partition /dev/sdXN` | Optional, with `--target`. Install beside the other system in place of this one partition; implies `--dual-boot` |

---

## Partition layout

The installer writes a **hybrid GPT** layout so one disk image boots on legacy BIOS machines, UEFI-only laptops, and Hyper-V Gen 2 alike.

| # | Name | Range | Filesystem | Purpose |
| :-- | :--- | :--- | :--- | :--- |
| 1 | `bios_grub` | 1 MiB – 2 MiB | none, flag `bios_grub on` | Lets legacy GRUB embed `core.img` on a GPT disk |
| 2 | `ESP` | 2 MiB – 514 MiB | FAT32, flag `esp on` | UEFI bootloader files |
| 3 | `ROOT` | 514 MiB – (end − 1537 MiB) | ext4, label `LABKIOSK_ROOT` | The image store: `boot/grub/` and the system images under `images/<version>/` |
| 5 | `SWAP` | (end − 1536 MiB) – (end − 512 MiB) | none; GPT type Linux swap | Swap behind compressed RAM, encrypted at every boot with a key that never leaves RAM, by PARTUUID |
| 4 | `DATA` | last 512 MiB | ext4, label `LABKIOSK_DATA`; on a machine with a TPM 2.0 chip, a LUKS2 container with that ext4 inside | Mounted at `/etc/labkiosk` with `nofail`, by UUID ([Encrypted data partition](#encrypted-data-partition)) |

`SWAP` is partition 5 although it sits before `DATA`: it is created last so that `DATA` keeps number 4 on every disk. Disks installed before it existed have no swap partition and use compressed RAM alone.

### Why partition 4 exists

`overlayroot="tmpfs"` is configured on the installed drive too, so every write on a running workstation lands in RAM and is discarded at power-off. That is the point — but it also means a workstation enrolled *after* installation would forget its device token on the next reboot, and any configured Wi-Fi credentials or static IP settings would be lost.

`LABKIOSK_DATA` is the single deliberate exception. It holds:

1. `/etc/labkiosk/config.json` — device bearer token, client ID, and worker URL.
2. `/etc/labkiosk/proxy.json` — organization proxy settings.
3. `/etc/labkiosk/system-connections/` — NetworkManager connection profiles, bind-mounted to `/etc/NetworkManager/system-connections` on boot.
4. `/etc/labkiosk/logs/` — root's: the system journal of the last seven days (at most 128 MiB), and a report for each boot that ended without shutting down, which the agent sends to the console (`labkiosk-logs`).

Everything else on an installed machine, `/etc/machine-id` and browser cache included, is regenerated or reset on every boot.

### Negative parted offsets need `--`

ROOT, SWAP and DATA are sized from the end of the disk (`-1537MiB`, `-1536MiB`, `-512MiB`). Without a `--` separator, parted parses those as bundled single-letter options and aborts the install.

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
 5. mkfs.fat -F32 on ESP, mkfs.ext4 on ROOT and DATA (with a TPM 2.0 chip: LUKS2 on DATA, opened with a
    random one-time key in /run, and ext4 inside it)
 6. mount ROOT, ESP and DATA at three separate directories
 7. copy the image to ROOT/images/<version>/, fsync each file
 8. carry network profiles, config.json, proxy.json and localization.json onto DATA; prove kiosk can write it
 9. grub-install x86_64-efi, x86_64-efi --removable, i386-pc, all with --boot-directory=ROOT/boot
10. copy usr/share/labkiosk/boot/grub.cfg to ROOT/boot/grub/, write labkiosk-password.cfg if a hash was supplied,
    labkiosk-data.cfg with the DATA file system's UUID, labkiosk-swap.cfg, labkiosk-hostname.cfg and, when
    DATA is encrypted, labkiosk-datacrypt.cfg with the container's UUID and the one-time key (labkiosk-data.key, 0600)
11. labkiosk-boot-slots init <version>: grubenv with current=<version>
```

Nothing is written into the system image: an update replaces it whole. What used to be written onto the
root filesystem moved (OTA §5.2): `/etc/fstab` became `etc-labkiosk.mount` (generated at boot from the DATA
partition's UUID, which GRUB passes as `labkiosk.data=`; never by label) and a bind-mount unit in the image, `/etc/labkiosk-installed` became `labkiosk.installed=1` on the command line, the boot password moved
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
| `grub-install --target=x86_64-efi --efi-directory=<ESP> --boot-directory=<ROOT>/boot --uefi-secure-boot --bootloader-id=LabKiosk --no-nvram --recheck` | `EFI/LabKiosk/` on the ESP; `--no-nvram` leaves the firmware's boot variables untouched |
| `grub-install --target=x86_64-efi --efi-directory=<ESP> --boot-directory=<ROOT>/boot --uefi-secure-boot --removable --recheck` | `EFI/BOOT/BOOTX64.EFI` fallback, for firmware that loses NVRAM boot variables |
| `grub-install --target=i386-pc --boot-directory=<ROOT>/boot <disk> --recheck` | Legacy BIOS, embedding into the `bios_grub` partition |

`--uefi-secure-boot` installs Microsoft's signed `shim` in front of Debian's signed GRUB, which boots only Debian-signed kernels, so the disk starts with Secure Boot on ([Kiosk Hardening](Kiosk-Hardening#secure-boot)). It is named rather than left to grub-install's default, which depends on how the live session itself was started.

All three run on every install to a SATA or virtio disk, so the drive boots regardless of the machine's firmware mode. On an NVMe or eMMC target the `i386-pc` install is skipped and the drive boots through UEFI only. The install fails only when no boot loader at all could be installed.

---

## Beside another system (dual boot)

The wizard's **Install beside the system already on the drive** keeps the other system, Windows or another Linux, and adds Lab Kiosk next to it. It works only on a computer started in **UEFI** mode, on a **GPT** disk that has an **EFI system partition**; the wizard says which of these is missing when it cannot offer it.

**Where it goes.** Either the disk's largest free stretch (shrink a partition from the other system first to make one), or one partition the administrator gives up, together with any free space beside it. It needs 7 GiB. Lab Kiosk creates four partitions there: an EFI system partition of its own, and the three it has on an erased drive, with the same roles and sizes:

| Name | Size | Purpose |
| :--- | :--- | :--- |
| `LABKIOSK_ESP` | 128 MiB | Lab Kiosk's boot loader (FAT32, flag `esp on`) |
| `LABKIOSK_ROOT` | the rest | The image store |
| `LABKIOSK_SWAP` | 1 GiB | Swap, encrypted at every boot |
| `LABKIOSK_DATA` | 512 MiB | `/etc/labkiosk`, encrypted with the TPM where there is one |

Their numbers are whatever the disk had free, read back from the partition table; nothing depends on them, because GRUB finds each by UUID.

**What it never touches.** Every other partition, the other system's EFI system partition included, and the disk's boot sector. GRUB goes into `EFI/LabKiosk/` on Lab Kiosk's own ESP (`--no-nvram`, without `--removable`, no `i386-pc`).

Why its own ESP: Debian's signed GRUB, which Lab Kiosk boots through with Secure Boot on, first reads `EFI/debian/grub.cfg` on the partition it was started from. On an ESP shared with Debian or a Debian-based system that file is the other system's menu, so Lab Kiosk would start the other system instead. The VM boot test plants such a menu and checks that it is never read.

**How it starts.** The installer registers a firmware boot entry of its own and puts it first:

```bash
efibootmgr --create --disk <disk> --part <LABKIOSK_ESP number> --label "Lab Kiosk" --loader '\EFI\LabKiosk\shimx64.efi'
```

so the computer starts into the kiosk with nobody at the keyboard, Secure Boot on. To start the other system, choose it in the firmware's boot menu (often F12, F11 or Esc at power-on). Entries left by an earlier Lab Kiosk install are removed first. If the firmware does not keep the entry first in its boot order, the install reports it as failed and says which file to choose in the firmware's settings.

**What it refuses.** Before writing anything it checks: UEFI, GPT, an EFI system partition the other system starts from, 7 GiB to install into, and nothing on the disk mounted, in use as swap or held open (an unlocked BitLocker or LUKS volume, an active LVM volume). Close the other system's volumes, or start the installer again, rather than expect it to unmount them.

**The risk.** A shared disk is only as safe as the other system. Anyone with administrator rights there can change or delete Lab Kiosk's partitions and its boot entry. The TPM encryption of `LABKIOSK_DATA` is sealed to PCR 7, which records which signing authorities started the system: it keeps the enrolment unreadable from Windows, which starts through Microsoft's own authority, but not from another Linux started through the same Debian shim and GRUB. The wizard therefore asks the administrator to tick **I understand that administrators of the other system can change Lab Kiosk** before it installs, and the agent refuses the request without it (`acceptRisk`).

A firmware password should guard the firmware's boot menu as well, or a user can simply start the other system.

---

## Hostname

Every workstation gets a hostname of its own; the image's one `/etc/hostname` is replaced at each boot by `labkiosk-hostname.service`, before the network comes up, so DHCP and the network see that name.

- **At installation.** The wizard's **Set the hostname myself** box is unticked by default and the installer generates `labkiosk-` and six random hex digits (`labkiosk-3fa92c`). Ticked, it takes the name typed there: one DNS label, 1–63 lowercase letters, digits and hyphens, not starting or ending with a hyphen. The agent and the installer both re-validate it. It is stored in `boot/grub/labkiosk-hostname.cfg`, outside every image, so updates keep it, and GRUB passes it as `labkiosk.hostname=`.
- **Without a stored name** (the live ISO, or a disk installed before names were stored): `labkiosk-` and six hex digits derived from the lowest permanent MAC address of the machine's network cards, so the same machine always gets the same name. A machine with no network card gets a random one for that boot.

To change the name of an installed workstation, reinstall it.

---

## Encrypted data partition

On a machine with a TPM 2.0 chip, `DATA` (device token, Wi-Fi passwords, the journal) is encrypted and still unlocks with nobody at the keyboard: the key is sealed to the chip and to the Secure Boot state (PCR 7), so the disk opens on this machine and nowhere else. A machine without a TPM 2.0 chip keeps a plain partition.

1. **Install.** The installer checks for the chip (`/dev/tpmrm0`, `tpm_version_major` 2) in the live session, which runs on the same machine. It formats `DATA` as LUKS2 with a random one-time key and leaves that key in `boot/grub/labkiosk-data.key` (root only).
2. **First boot.** `labkiosk-data-unlock.service`, before `/etc/labkiosk` is mounted, opens the volume with that key, adds a key slot sealed to the TPM (`systemd-cryptenroll --tpm2-pcrs=7`), destroys the one-time slot and deletes the key file. Sealing happens here, not in the installer, because PCR 7 must be measured by the installed boot.
3. **Every boot.** `systemd-cryptsetup` opens it with the TPM (`headless=true`: it never asks for anything).
4. **When the TPM no longer releases the key** (Secure Boot turned off or its keys changed by a firmware update, the TPM cleared, the disk moved to another machine) the data cannot be read again. The volume is recreated, empty, with the same UUIDs and sealed to the chip as it is now, and the workstation shows the enrolment form: enrol it again from the console. If the chip does not answer at all (disabled in the firmware), nothing is erased: `/etc/labkiosk` stays in RAM until it is back.

Turn Secure Boot on **before** installing: switching it on afterwards changes PCR 7, which counts as case 4. What this protects is a drive taken out of the machine. A whole stolen machine still boots and unlocks itself, so lock the firmware (setup password, boot order) as well.

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
