# Over-the-Air Updates — Research

**Status:** research, nothing implemented. **Scope:** delivering new Lab Kiosk releases to installed
workstations without re-flashing the ISO. Written against `dev` at v2.5.0.

---

## 1. Recommendation

1. **Ship whole, signed system images into A/B slots, not packages or file patches.** Store each
   slot as a file on the existing `LABKIOSK_ROOT` ext4 partition (`/slots/a`, `/slots/b`), each
   holding the `filesystem.squashfs`, `vmlinuz` and `initrd.img` the ISO build already produces.
   Boot the active slot with live-boot (`live-media-path=/slots/a`), the same way the ISO boots
   today. Use GRUB environment boot counting so a slot that fails its health check falls back on
   its own.
2. **The update payload is the ISO's own squashfs.** CI already builds it on every tag, so no
   second build pipeline is needed. Add a signed manifest and upload the payload next to it.
3. **The v2.5.0 fleet needs one more reinstall.** Nothing on an installed v2.5.0 disk can fetch or
   install code, so the first OTA-capable release has to go on by ISO. That same reinstall is the
   cheapest moment to switch the disk to the slot layout, so do both in one release.
4. **Don't start with an app-only update channel.** The agent, extension and wizard are only about
   420 KB, which makes a small app-only bundle tempting. But half of recent client changes touched
   the OS layer, and Chromium security fixes can only arrive through a new image. Add an app-only
   channel later, and only if measured bandwidth shows you need it (§8).

A correction to the premise: **feature releases are the lesser reason to build this.** Today an
installed workstation runs the Chromium it was installed with, forever. Debian ships Chromium
security fixes often, and none of them reach the fleet without a reinstall. Plan OTA as a
security update channel that also carries features.

---

## 2. What the code does today

| Fact | Where |
|---|---|
| Installed disk: `bios_grub`, ESP (512 MiB), `ROOT` ext4 (the rest of the disk minus 513 MiB), `DATA` ext4 (512 MiB) | `labkiosk-install` `install_to_disk()` |
| ROOT is an **rsync of the running live rootfs**, not an image. It boots as a normal ext4 root under `overlayroot="tmpfs:recurse=0"` | `labkiosk-install`, `etc/overlayroot.conf` |
| Reinstalling is refused on an installed disk (`is_live_session()`), and `POST /api/install` returns 400 | `labkiosk-install`, `agent.py` |
| The agent runs as the unprivileged `kiosk` user, restarted in a loop by the Openbox autostart. Its only root paths are two single-binary sudo rules (installer, localization) | `etc/openbox/autostart`, `01-lockdown.hook.chroot` |
| The command set is `lock/unlock/navigate/reload/reboot/shutdown/clear-session/mute`. There is no update or exec path | `agent.py` `execute_command()` |
| The agent version appears only in the `User-Agent` string. D1 stores no agent or image version for a device | `agent.py` `AGENT_VERSION`; `src/db.ts` `client_devices` |
| At install time these are written onto ROOT: `/etc/fstab`, `/etc/overlayroot.conf`, `/etc/labkiosk-installed`, an empty `/etc/machine-id`, `/etc/grub.d/01_labkiosk_password`, and localization (`/etc/localtime`, `/etc/default/locale`, `/etc/default/keyboard`, the timesyncd drop-in, generated locales) | `labkiosk-install`, `labkiosk-localization --root` |
| `DATA` is mounted at `/etc/labkiosk`, **owned by `kiosk`**, mode 0700 | `labkiosk-data-permissions` |
| The kernel command line pins `timezone=Asia/Kolkata username=kiosk` for live-config | `distro-builder/auto/config` |
| v2.5.0 ISO: 753 926 144 bytes (719 MiB). CI publishes it as a GitHub Release on `v*` tags | Release `v2.5.0`, `.github/workflows/build-iso.yml` |
| App layer (`/opt/labkiosk` + `/usr/local`): about 420 KB in source | `du` on `includes.chroot` |
| Of the 39 commits that touched `distro-builder/config`, 20 changed only `/opt/labkiosk` or `/usr/local`. The other 19 changed hooks, package lists, bootloaders, Chromium policy base or Openbox config | `git log` over this repo |
| Worker already binds R2 (`labkiosk-audit-archive`) and D1 (migrations 0001–0014) | `wrangler.jsonc`, `migrations/` |

---

## 3. Constraints the design must respect

- **Invariant 2 (RAM overlay, read-only root)** rules out `apt upgrade` on the device. It would
  write into tmpfs and disappear at power-off.
- **Updating today's layout in place is unsafe.** On an installed disk the ext4 ROOT is the
  overlayfs *lower* layer. The kernel documentation says changes to an underlying filesystem
  while the overlay is mounted are not allowed and give undefined behaviour (no crash, but no
  guarantees). An rsync onto `/media/root-ro` while the system is running is exactly that. It
  also has no rollback.
- **Invariant 9 (unattended boot, never stranded).** A bad update must fall back without anyone
  at the keyboard, and no update step may add a prompt to the boot path.
- **Invariant 10 (fail closed).** A missing signature, key or manifest is an error, never a skip.
- **Invariant 4 (tenancy).** Rollout policy is per organization. New routes need guards and
  negative tests.
- **Privilege separation.** The agent is the internet-facing process with a local HTTP API.
  It must not be able to install code. The component that writes a system image runs as root and
  trusts only a signature, not the agent or the Worker.
- **The `DATA` partition is writable by `kiosk`.** Nothing executable may be trusted from it
  unless a root process verified a root-owned copy (to avoid a time-of-check/time-of-use swap).
- **Offline organizations exist.** The "slot is healthy" decision cannot depend on reaching the
  control plane.

---

## 4. Options considered

| Option | Rollback | Covers Chromium/OS | Fits this codebase | Verdict |
|---|---|---|---|---|
| `apt` on device (unattended-upgrades) | none | yes | breaks invariant 2; drifts every device | **reject** |
| rsync new rootfs onto today's ROOT (lower layer) | none | yes | undefined overlayfs behaviour while mounted; half-written root if power fails | **reject** |
| App-only bundle (`/opt/labkiosk`, `/usr/local`) | easy | **no** | small; half of client changes don't fit | later, optional (§8) |
| **A/B slot files on ROOT ext4 + live-boot + GRUB env** | yes, automatic | yes | reuses ISO artifact and boot path; ROOT already spans the disk | **recommended** |
| A/B partitions + RAUC | yes | yes | RAUC 1.8 is in bookworm (`rauc`, `rauc-service`) and has a GRUB backend. Fixed partition sizes and the GRUB integration still have to be written. File-backed slots are supported but less trodden | credible alternative |
| OSTree | yes | yes | needs a different rootfs and boot layout, plus deploying via the ostree toolchain; not live-build shaped | too large a change |
| systemd-sysupdate | yes | yes | bookworm's systemd 252 is built without it | not available on Debian 12 |
| Mender / hosted OTA services | yes | yes | adds an external server and client; overlaps what the Worker already does | reject for now |

**Why build the updater instead of adopting RAUC.** The unusual parts are the GRUB script and the
health check, and those have to be written either way. What's left for an updater is downloading
a file, checking a signature, writing into the inactive slot, fsync, rename, and editing
`grubenv`. That's a few hundred lines of Python in the style of `labkiosk-install`. RAUC mainly
adds bundle formats and slot handlers aimed at partitions. **Revisit this** if streaming or block
delta updates become necessary (§9), because that's where RAUC's maturity pays off. I have not
prototyped either approach.

---

## 5. Recommended design

### 5.1 Disk layout and boot

Keep the four partitions exactly as they are. Only the contents of ROOT change:

```text
LABKIOSK_ROOT (ext4)
├── boot/grub/          grub.cfg, grubenv, 01_labkiosk_password material (outside every slot)
├── slots/a/            filesystem.squashfs  vmlinuz  initrd.img  manifest.json  manifest.sig
├── slots/b/            (same; the inactive slot receives the next update)
└── slots/.incoming/    partial download, renamed into the inactive slot only when complete
```

Each GRUB entry is `--unrestricted` (so boot never prompts) and boots, for example:

```text
linux  /slots/a/vmlinuz boot=live components live-media=/dev/disk/by-label/LABKIOSK_ROOT \
       live-media-path=/slots/a labkiosk.installed=1 consoleblank=0 username=kiosk
initrd /slots/a/initrd.img
```

live-boot then provides the tmpfs overlay itself, so `overlayroot` is no longer needed on
installed disks. The installed and live paths become the same code path. Because the overlay's
lower layer is now the squashfs and not the ext4 filesystem, writing the *other* slot's files
while running doesn't touch any mounted overlay layer. That removes the undefined-behaviour
problem in §3.

**Knock-on changes this layout requires (all are real bugs if missed):**

- `is_live_session()` in the agent and installer keys on `/run/live` and `boot=live`, which would
  now also match installed disks. Key it on `labkiosk.installed=1` on the command line instead.
- `labkiosk-medium.shutdown` prompts to remove a USB stick whenever `boot=live` is set and the
  medium is USB. A workstation *installed* to a USB disk (the installer allows removable targets)
  would then prompt on every reboot. Skip it when `labkiosk.installed=1`.
- The installed command line must not carry `timezone=Asia/Kolkata`. live-config applies it at
  every boot and would override the organization's choice.
- `/etc/labkiosk` mount: the image's `fstab` no longer comes from the installer. Ship a systemd
  mount unit for `LABKIOSK_DATA` by label, keeping `nofail`, plus the existing
  `labkiosk-data-permissions` ordering and the `system-connections` bind mount.

### 5.2 State that must survive an image swap

Anything the installer writes onto ROOT today would be lost on the first update. It must move:

| Today on ROOT | Moves to |
|---|---|
| `/etc/fstab`, `/etc/overlayroot.conf` | mount unit in the image; overlay from live-boot |
| `/etc/labkiosk-installed` | `labkiosk.installed=1` on the command line |
| `/etc/grub.d/01_labkiosk_password` | `boot/grub/` on ROOT, outside every slot; the updater regenerates `grub.cfg` and keeps it |
| Timezone, locale, keyboard, NTP (written with `--root`) | apply at boot from `DATA/localization.json` with `labkiosk-localization` (it already supports `/`). Pre-generate the supported locales at build time so boot doesn't run `localedef` |
| empty `/etc/machine-id` | unchanged: regenerated into RAM at every boot, as today |

Config on `DATA` (`config.json`, `proxy.json`, `localization.json`) is shared by both slots, so
**after a rollback the older release will read config written by the newer one.** From now on,
config changes must be additive: new keys may be added, but existing keys must never be renamed
or change meaning.

### 5.3 Payload, manifest and signing

- **Payload:** `filesystem.squashfs`, `vmlinuz` and `initrd.img` taken from the CI build's
  `binary/live/` (the same bits as the ISO), plus `manifest.json`:
  `{version, channel, files: [{name, size, sha256}], minFromVersion, securityFloor, builtAt}`.
- **Signature:** CI signs `manifest.json` with an offline-held Ed25519 or OpenPGP key kept in a
  GitHub secret. A build with no key fails (invariant 10). The public key, **plus the next
  rotation key**, is baked into the image at `/usr/share/labkiosk/update-keys/`.
- **Verification tool:** `gpgv` is present because `apt` depends on it in bookworm. *Check that
  it is actually in the built image.* If it isn't, add `signify-openbsd` to the package list.
  Never hand-roll crypto on the client.
- **Downgrade protection:** the device refuses any manifest whose `version` is below its own
  `securityFloor`. It accepts an older version only when the signed manifest names that version
  as a permitted rollback target. Without this, a compromised control plane could push an old,
  vulnerable image that is still validly signed.
- **Trust boundary:** the Worker only chooses *which* signed release a device gets and *when*.
  It cannot mint a release. A compromised Worker can therefore delay updates, but cannot use
  them to execute code.

### 5.4 Client updater

A new root-owned `labkiosk-update` (Python, same conventions as `labkiosk-install`: JSON-only
stdout, `\Z` regexes, explicit errors) run by `labkiosk-update.service` and a timer:

```text
1. GET /api/devices/update   (device bearer token from /etc/labkiosk/config.json, read as root)
2. Nothing offered → exit.  Offered → download manifest + signature, verify, check the version rules
3. Remount the live medium rw; stream each file to slots/.incoming with HTTP Range resume
4. Verify every sha256; fsync; rename .incoming → inactive slot (atomic on ext4)
5. Regenerate grub.cfg; set grubenv so the new slot is next in ORDER with one try; remount ro
6. Report "staged" (version, slot) on the control channel
7. Reboot in the organization's maintenance window, or on the existing operator `reboot` command
```

- **Keeping it out of the agent.** The agent stays unprivileged. The hub can push a new
  `update-check` action, and the agent then starts the unit through one narrow rule: a sudo rule
  or polkit rule that allows only `systemctl start labkiosk-update.service`. The agent passes no
  arguments. It can't pick a URL, version or file.
- **Space.** The updater overwrites the inactive slot, never the active one, so the disk needs
  two slots plus the partial download. At 719 MiB per image that's about 1.5 GiB. The installer's
  current 3 GB minimum leaves ROOT at about 1.9 GiB, which doesn't leave room for the image to
  grow. **Raise the minimum to 8 GB.** Measure the real squashfs size first (see §10).

### 5.5 Boot counting and rollback

RAUC's GRUB scheme uses `grubenv` variables `ORDER`, `A_OK`, `A_TRY`, `B_OK`, `B_TRY`:

```text
load_env ORDER A_OK A_TRY B_OK B_TRY
for SLOT in $ORDER; do
  # first slot that is marked OK and not yet tried this cycle wins; mark it tried
  ... set A_TRY=1; save_env A_TRY; set default=slot_a; break ...
done
```

- GRUB can write `grubenv` on ext4. It can't on LVM, RAID or compressed btrfs, none of which this
  layout uses.
- `labkiosk-boot-ok.service` runs after `nodm`. It marks the slot good (`X_OK=1`, `X_TRY=0`)
  once the agent's `127.0.0.1:8888` API answers and Chromium has stayed up for a set time.
  **It doesn't wait for the control plane**, so an organization that is offline at boot doesn't
  roll back a healthy image.
- A slot that never gets marked good is skipped on the next boot, which falls back to the other
  slot. The updater reports the rollback the next time it reaches the Worker.
- A power cut during download leaves only `.incoming` behind, and the active slot is untouched.
  A power cut during the `grubenv` write is covered by GRUB's fixed-size environment block
  (1 KiB, rewritten in place).

### 5.6 Control plane

- **D1 (new migration 0015 and `SCHEMA_SQL`):**
  - on `client_devices`: `agent_version`, `image_version`, `active_slot`, `update_state`,
    `update_error`, `update_state_at`;
  - platform table `releases`: `version`, `channel`, `manifest`, `signature`, `r2_prefix`,
    `size_bytes`, `published_at`, `revoked_at`;
  - organization settings: `update_channel` (`stable`/`beta`/`pinned`), `pinned_version`,
    `maintenance_window`, `auto_reboot`.
  - None of these are CHECK changes on a parent table, so the cascade-safe rebuild isn't needed.
    Check this against `labkiosk-d1-schema` when writing it.
- **Routes:**
  - `GET /api/devices/update` (`requireDevice`): returns the offer for this device's organization
    policy and rollout ring.
  - `GET /api/devices/update/file/:name` (`requireDevice`): streams from R2 with `Range` support.
  - Organization policy is edited through the Settings permission (`requireTenantPermission`).
  - Publishing and revoking releases is `requireSuperAdmin`, because releases are platform data,
    not tenant data.
  - Every route gets negative tests: another organization's device, a revoked token, a revoked
    release.
- **Rollout rings:** `hash(device_id) mod 100 < ring_percent`, raised in steps (for example
  5 → 25 → 100). Rollout pauses on its own if the rollback rate for a release crosses a
  threshold.
- **Storage:** a new R2 bucket such as `labkiosk-releases`. R2 has no egress fees, so the cost
  of a release lands on the organization's uplink, not the platform. Serving through the Worker
  keeps downloads tied to an enrolled device, which fits the license terms.
- **Visibility:** the Workstations view shows image and agent versions, update state and
  rollbacks. The hub pushes `update-check` when a release is published or the policy changes.

### 5.7 Build and release

- `build-iso.yml` also uploads the `binary/live/` files, `manifest.json` and the signature to R2
  and inserts the `releases` row (or leaves it for a super admin to promote).
- Add a **scheduled rebuild** (for example weekly) that produces a security-only release with a
  patch-level version. That's what actually gets Debian's Chromium and kernel fixes onto the
  fleet.
- Make the squashfs as reproducible as live-build allows (`SOURCE_DATE_EPOCH`, stable file
  order). This matters only for delta updates later (§9).

---

## 6. Moving the v2.5.0 fleet

1. Release N (the first OTA release) ships the updater, the slot-layout installer, the §5.2
   state moves, and the Worker routes.
2. **Installed v2.5.0 disks must be reinstalled once** from the release N ISO. This is
   unavoidable: they have no path to receive code, and installing over them is refused by design.
   Enrolment survives if the organization re-enrols from the live session before installing, as
   today. Wi-Fi profiles carry across as they do now.
3. From release N+1 on, updates arrive over the air.

The installer should keep refusing to repartition an installed disk. A separate, deliberate
"convert this disk to the slot layout" path isn't worth building for one transition.

---

## 7. Phased plan

| Phase | Deliverable | Verify with |
|---|---|---|
| 1 | Slot-layout installer; §5.1 knock-on fixes; §5.2 state moves; GRUB boot counting; `labkiosk-boot-ok` | QEMU + OVMF and SeaBIOS: install, boot, force a failed health check, see fallback |
| 2 | Signed manifest in CI; `labkiosk-update` with manual trigger; R2 upload | QEMU: A→B update, power cut mid-download, tampered signature, downgrade rejected |
| 3 | D1 migration, device routes with negative tests, console visibility, organization policy, rings, `update-check` push | `pnpm test`, then a real two-VM rollout against `pnpm dev` |
| 4 | Scheduled security rebuilds; auto-pause on rollback rate | a week of scheduled builds landing on a canary ring |

The Docker simulator can't exercise GRUB, live-boot or slots. It can exercise the updater's
download, verify and report logic against the dev server.

---

## 8. The app-only channel, if it is ever needed

If one full image per release costs too much uplink (for example 45 workstations × 719 MiB ≈
32 GiB per release), add a second, smaller channel for releases that touch only `/opt/labkiosk`
and `/usr/local`:

- Payload: a signed squashfs of those two trees (hundreds of KB). It declares the range of image
  versions it supports.
- Store it on **ROOT** (`/apps/<version>/`), which only root can write. Don't store it on `DATA`,
  which `kiosk` owns.
- At boot, a root unit verifies it and bind-mounts it read-only over `/opt/labkiosk` and the two
  sudo-listed binaries. A failed health check drops back to the image's built-in copy.
- Cost: a compatibility matrix between app and image versions, and a second rollback path. Given
  the 20/19 commit split and the regular Chromium rebuilds, most releases would still need the
  full image, so measure before building this.

---

## 9. Bandwidth, later

In order of effort:

1. Reboot windows spread across the organization, so the uplink isn't saturated at once.
2. Chunk-level delta: publish a content-defined chunk index (casync-style) of each squashfs, so
   a device downloads only chunks it doesn't already have in its active slot. This needs a
   reproducible squashfs, and should be judged on a measured delta between two real builds.
   RAUC's adaptive updates are the off-the-shelf version of this.
3. A LAN cache: one workstation per site fetches, the others pull from it. Only worth it for
   large sites.

---

## 10. Open questions and unverified points

- **Squashfs size and install footprint.** 719 MiB is the ISO. Measure `binary/live/`
  directly before settling the minimum disk size.
- **`gpgv` in the built image.** It is expected because of `apt`, but not checked.
- **How often Debian ships Chromium security updates for bookworm.** This is from memory, not
  checked here (Debian's sites were unreachable from this environment). Confirm on the Debian
  security tracker; it sets the cadence of the scheduled rebuild.
- **live-boot with `live-media=` pointing at an internal ext4 partition.** `live-media-path=`
  is documented, and GParted Live uses this pattern from a hard disk, but it hasn't been tested
  on this image. It is the first thing to prototype in phase 1.
- **Chromium and its unpacked extension across an image swap.** The profile lives in `/tmp` and
  is wiped at every launch, so no migration is expected. Confirm this in the phase 1 VM.

---

## Sources

- Repository: `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`,
  `…/opt/labkiosk/agent/agent.py`, `…/etc/openbox/autostart`, `…/etc/overlayroot.conf`,
  `distro-builder/config/hooks/live/01-lockdown.hook.chroot`, `distro-builder/auto/config`,
  `.github/workflows/build-iso.yml`, `cloudflare-control/src/db.ts`, `cloudflare-control/wrangler.jsonc`
- [GitHub release v2.5.0](https://github.com/akbhoi/labkiosk/releases/tag/v2.5.0) (ISO asset size)
- [Overlay Filesystem — Linux kernel documentation](https://docs.kernel.org/filesystems/overlayfs.html)
- [rauc in Debian bookworm](https://packages.debian.org/bookworm/rauc),
  [rauc-service in bookworm](https://packages.debian.org/bookworm/rauc-service)
- [RAUC examples (GRUB `ORDER`/`A_OK`/`A_TRY`)](https://rauc.readthedocs.io/en/latest/examples.html),
  [RAUC system configuration reference](https://rauc.readthedocs.io/en/latest/reference.html)
- [Debian bug #1049923: request to include systemd-sysupdate](https://www.mail-archive.com/pkg-systemd-maintainers@alioth-lists.debian.net/msg08611.html)
- [live-boot(7), bookworm](https://manpages.debian.org/bookworm/live-boot-doc/live-boot.7.en.html),
  [GParted Live on a hard disk](https://gparted.org/livehd.php)
