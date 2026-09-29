# Over-the-Air Updates — Research

**Status:** research, nothing implemented. **Scope:** delivering new Lab Kiosk releases to installed
workstations without re-flashing the ISO. Written against `dev` at v2.5.0.

---

## 1. Recommendation

The update model, as the product owner specified it:

1. **No new partition.** The disk keeps its four partitions. The existing `LABKIOSK_ROOT`
   partition becomes the writable store for system images. Only root can write to it, and the
   running system still runs from a RAM overlay (invariant 2).
2. **Updates download on their own, in the background.** When a release is published, every
   installed workstation downloads and verifies it while the kiosk keeps working. The download
   is only stored, not installed.
3. **Nothing installs without an admin.** In the console, the admin selects workstations and
   clicks **Install update**. Only workstations that already hold the downloaded update act on
   it.
4. **Selected screens lock with a "Getting update" screen** while the install runs: verify →
   reboot into the new system → health check → unlock. The download is already done, so this
   takes a few minutes, not the length of a download. Measure the real time in phase 1.
5. **A failed update rolls itself back.** The previous system image stays on disk. If the new
   one doesn't pass its health check, the workstation boots the old one, unlocks, and the
   console shows "Update failed, rolled back".

How it's built underneath:

- **The update is a whole, signed system image**, the same `filesystem.squashfs`, `vmlinuz` and
  `initrd.img` the ISO already contains. There are no package or file patches on the device.
- **Security fixes ship as rebuilt images** (§7). Android and ChromeOS do the same. `apt` never
  runs on a workstation.
- **The v2.5.0 fleet needs one more reinstall** (§8). Nothing on a v2.5.0 disk can fetch or
  install code.

A correction to the premise: **feature releases are the lesser reason to build this.** Today an
installed workstation runs the Chromium, kernel and libraries it was installed with, forever.
Debian 12 left regular security support in July 2026 and is now on LTS (§7). Plan this as a
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
| Commands already go to **selected workstations or groups** as batches (≤ 500 ids). The extension already draws a full-screen **lock curtain** with a message, in a Shadow DOM | `labkiosk-control` skill; `extension/content.js` |
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
  while the overlay is mounted are not allowed and give undefined behaviour. An rsync onto
  `/media/root-ro` while the system runs is exactly that. It also has no rollback. That's why
  the design stores images as files and switches between them at boot.
- **Invariant 9 (unattended boot, never stranded).** A bad update must fall back without anyone
  at the keyboard, and no update step may add a prompt to the boot path.
- **Invariant 10 (fail closed).** A missing signature, key or manifest is an error, never a skip.
- **Invariant 4 and 5 (tenancy, delegation).** Approval is per organization, and it is guarded
  by a staff permission. New routes need guards and negative tests.
- **Privilege separation.** The agent is the internet-facing process with a local HTTP API.
  It must not be able to install code, or choose what gets installed. The component that writes
  images runs as root and trusts only a signature, not the agent or the Worker.
- **`DATA` is the wrong store for images.** It's 512 MiB (smaller than one image), and it's
  writable by `kiosk`, so anything there could be swapped by the browser's own user.
- **Offline organizations exist.** The "new image is healthy" decision cannot depend on
  reaching the control plane.

---

## 4. Options considered

| Option | Rollback | Covers Chromium/OS | Verdict |
|---|---|---|---|
| `apt` on device (unattended-upgrades) | none | yes | **reject.** Breaks invariant 2; every device drifts (§7) |
| rsync new rootfs onto today's ROOT (the overlay's lower layer) | none | yes | **reject.** Undefined overlayfs behaviour; a power cut leaves a half-written root |
| Add a new "updates" partition | — | — | **not needed.** ROOT already spans the disk and becomes the image store |
| App-only bundle (`/opt/labkiosk`, `/usr/local`) | easy | **no** | later, optional (§10) |
| **Image files on ROOT + live-boot + GRUB one-try boot + admin approval** | yes, automatic | yes | **recommended** |
| RAUC (in bookworm as `rauc`, `rauc-service`) | yes | yes | credible alternative. Built around partitions; GRUB script and health check still ours |
| OSTree | yes | yes | too large a change; not live-build shaped |
| systemd-sysupdate | yes | yes | bookworm's systemd 252 is built without it |

**Why build the updater instead of adopting RAUC.** The parts unique to Lab Kiosk (the GRUB
script, the health check, the approval flow and the update screen) have to be written either
way. What's left is downloading a file, checking a signature, fsync, and editing `grubenv`.
That's a few hundred lines of Python in the style of `labkiosk-install`. Revisit this if block
delta updates become necessary (§11). I have not prototyped either approach.

---

## 5. Recommended design

### 5.1 Disk layout and boot — same four partitions

```text
bios_grub | ESP | LABKIOSK_ROOT (ext4, root-only image store) | LABKIOSK_DATA (settings, as today)

LABKIOSK_ROOT
├── boot/grub/                grub.cfg, grubenv, boot-menu password (outside every image)
└── images/
    ├── 2.6.1/                filesystem.squashfs  vmlinuz  initrd.img  manifest.json  manifest.sig
    └── 2.7.0/                (downloaded, waiting for approval, or the previous one kept for rollback)
```

At most **two** images are kept: the running one, plus either the downloaded update or the
previous one. A new download replaces the one that isn't running, and nothing ever writes the
running image.

GRUB boots the image named in `grubenv`. Every entry is `--unrestricted`, so boot never prompts:

```text
load_env current next next_tries
# if an update was approved, give it exactly one try; otherwise boot the current image
linux  /images/$slot/vmlinuz boot=live components live-media=/dev/disk/by-label/LABKIOSK_ROOT \
       live-media-path=/images/$slot labkiosk.installed=1 consoleblank=0 panic=10 username=kiosk
initrd /images/$slot/initrd.img
```

- **live-boot provides the RAM overlay**, so the installed disk boots exactly like the ISO, and
  `overlayroot` isn't needed on installed disks. The overlay's lower layer is the squashfs, not
  the ext4 partition. So writing a *different* image's files while running never touches a
  mounted overlay layer, which removes the §3 problem.
- `panic=10` makes a kernel panic reboot the machine, which lets GRUB fall back on its own.

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
| `/etc/grub.d/01_labkiosk_password` | `boot/grub/` on ROOT, outside every image; the updater regenerates `grub.cfg` and keeps it |
| Timezone, locale, keyboard, NTP (written with `--root`) | apply at boot from `DATA/localization.json` with `labkiosk-localization` (it already supports `/`). Pre-generate the supported locales at build time so boot doesn't run `localedef` |
| empty `/etc/machine-id` | unchanged: regenerated into RAM at every boot, as today |

Config on `DATA` is shared by every image, so **after a rollback the older release will read
config written by the newer one.** Config changes must be additive: new keys may be added, but
existing keys must never be renamed or change meaning.

### 5.3 Payload, manifest and signing

- **Payload:** `filesystem.squashfs`, `vmlinuz` and `initrd.img` from the CI build's
  `binary/live/` (the same bits as the ISO), plus `manifest.json`:
  `{version, channel, security, files: [{name, size, sha256}], securityFloor, builtAt}`.
- **Signature:** CI signs `manifest.json` with an offline-held key kept in a GitHub secret. A
  build with no key fails (invariant 10). The public key, **plus the next rotation key**, is baked
  into the image at `/usr/share/labkiosk/update-keys/`.
- **Verification tool:** `gpgv` should be present because `apt` depends on it in bookworm.
  *Check that it is actually in the built image.* If it isn't, add `signify-openbsd` to the
  package list. Never hand-roll crypto on the client.
- **Downgrade protection:** the device refuses any manifest whose `version` is below its
  `securityFloor`. Without this, a compromised control plane could send an old, vulnerable
  image that is still validly signed.
- **Trust boundary:** the Worker decides *which* signed release is offered and *when* an admin's
  approval arrives. It cannot mint a release. A compromised Worker can therefore delay or
  trigger an install, but can't use it to run its own code.

### 5.4 Background download (automatic, no disruption)

A root-owned `labkiosk-update` (Python, same conventions as `labkiosk-install`: JSON-only
stdout, `\Z` regexes, explicit errors). It runs as `labkiosk-update-download.service`, started
from a timer and nudged when the hub announces a release.

```text
1. GET /api/devices/update         → the release offered to this organization, or nothing
2. Already running or downloaded it → exit
3. Fetch manifest + signature; verify; enforce securityFloor
4. Remount ROOT rw; delete the image that isn't running; stream the files into images/<version>/
   with HTTP Range resume, a bandwidth cap and a random start delay; fsync; remount ro
5. Verify every sha256 again from disk; write images/<version>/.verified
6. Report "downloaded <version>" on the control channel
```

- **The kiosk keeps working throughout.** Nothing is locked, nothing reboots, and the running
  image is never touched.
- **A newer release before approval** simply replaces the downloaded one. There's only ever one
  update waiting.
- **The uplink is spread out.** A random start delay, an optional per-organization download
  window (for example 18:00–07:00), and a rate cap stop 45 machines from saturating the line
  at once.
- **A power cut mid-download** leaves an unverified folder. GRUB never boots it, because only
  approval can point `next` at it, and approval requires `.verified`. The next run restarts it.
- **Live USB sessions** don't download. They have no image store. The console shows them as
  "live session, update by re-flashing".

### 5.5 Admin approval and the "Getting update" screen

**In the console.** The Workstations view shows a column per machine:

| State | Meaning |
|---|---|
| Up to date · 2.6.1 | nothing waiting |
| Downloading 2.7.0 · 63 % | in progress, kiosk unaffected |
| **Ready to install 2.7.0** | verified on disk, waiting for approval |
| Installing… / Finishing… | the update screen is up |
| Updated to 2.7.0 | success |
| **Update failed — rolled back to 2.6.1** | new image failed its health check; old one running |

The admin selects workstations (individually or by group, using the existing batch selection)
and clicks **Install update**. The confirmation says how many are ready, lists any that aren't
(still downloading, offline, live USB) and **skips** those, and warns that the screens lock for
a few minutes. A machine that wasn't ready is never updated later on its own. The admin has to
approve it again once it shows "Ready", so a screen never locks by surprise in the middle of a
session.

**On each selected, ready workstation:**

```text
Agent (kiosk user)                              labkiosk-update-install.service (root)
──────────────────                              ───────────────────────────────────────
receives install-update {version}
shows the UPDATE curtain: "Getting update 2.7.0.
  Please don't turn off this computer."
starts the install unit (narrow sudo/polkit rule,
  no arguments)                           ───▶  re-verify signature + sha256 of images/<v>/
                                                refuse if not .verified or version ≠ offered
                                                grubenv: next=<v>, next_tries=1
                                                write /run status "rebooting"; reboot
 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ reboot into the new image ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
agent reads the update status → curtain          labkiosk-boot-ok.service: waits for the agent
  "Finishing update 2.7.0…"                       API + Chromium up for a set time
                                                pass → current=<v>, clear next; previous kept
curtain comes down; the lock state from          write /run status "installed <v>"
  before the update is restored
reports "updated to <v>"
```

- **The update curtain is a separate state from the operator's lock.** An operator's `unlock`
  doesn't dismiss it, and `reboot` and `shutdown` are refused while it's up. Once the update
  ends, the workstation returns to whatever lock state it had before, so a screen the operator
  had locked stays locked.
- **The agent can't choose what gets installed.** It starts the unit with no arguments. The
  root unit installs only the single verified download that's already on disk. The status the
  new boot shows comes from `grubenv` via a root-written file in `/run`. It never comes from
  `DATA`, which the browser's user can write.
- **What the screen shows during the reboot** is GRUB and the kernel for about a minute.
  There's no curtain yet, because no browser is running. The console shows "Rebooting…" so the
  admin can tell nothing is stuck. A boot splash could cover this later; it's out of scope here.
- **On failure**, the health check never passes, and the service reboots after a timeout. A
  panic reboots via `panic=10`. GRUB finds `next_tries` used up and boots `current`. The old
  image sees the failed attempt in `grubenv`, reports "failed, rolled back", and brings the
  curtain down.
- **A hard hang** during the new boot (a black screen, no panic) needs a power cycle, unless the
  machine has a hardware watchdog for systemd's `RuntimeWatchdogSec` to use. After a power cycle
  GRUB falls back, because the one try was spent. This is the only case that needs a person,
  and it never ends with a broken system.
- **Permission:** approving an install needs the `settings` permission, since it changes the
  operating system of the organization's machines. The `workstations` permission, used for
  daily lock and navigate, isn't enough. Approvals go in the audit log (who, when, which
  machines, which version). *This choice is open for confirmation (§12).*

**Security updates and approval.** Approval-only means a fix can wait on disk for weeks if no
admin clicks. To limit that:

- The console shows a banner when a release marked `security` has been ready for more than
  N days.
- Offer an organization setting, **off by default**, to install security releases
  automatically in a nightly window.

### 5.6 Boot selection and rollback

`grubenv` holds `current`, `previous`, `next`, `next_tries`:

- **Normal boot:** boot `current`.
- **After approval:** `next=<v>`, `next_tries=1`. GRUB decrements the counter and boots `next`
  once. If it's already `0`, GRUB boots `current` and leaves `next` so the old image can report
  the failure.
- **Health check passes:** `previous=current`, `current=next`, clear `next`.
- GRUB can write `grubenv` on ext4. It can't on LVM, RAID or compressed btrfs, none of which this
  layout uses. The environment block is a fixed 1 KiB, rewritten in place, so a power cut
  during a write can't corrupt the filesystem.
- **The health check is local.** It doesn't wait for the control plane, so an organization that
  is offline at boot doesn't roll back a healthy image.

### 5.7 Control plane

- **D1 (new migration 0015 and `SCHEMA_SQL`):**
  - on `client_devices`: `image_version`, `agent_version`, `update_version`, `update_state`,
    `update_progress`, `update_error`, `update_state_at`;
  - platform table `releases`: `version`, `channel`, `security`, `manifest`, `signature`,
    `r2_prefix`, `size_bytes`, `published_at`, `revoked_at`;
  - organization settings: `update_channel` (`stable`/`beta`), `download_window`,
    `download_rate_limit`, `auto_install_security` (default off).
  - None of these are CHECK changes on a parent table. Confirm with `labkiosk-d1-schema`.
- **Routes (each with a guard and negative tests):**
  - `GET /api/devices/update` (`requireDevice`): the release offered to this device's
    organization.
  - `GET /api/devices/update/file/:name` (`requireDevice`): streams from R2 with `Range` support.
  - `POST /api/…/workstations/install-update` (`requireTenantPermission('settings')`): takes the
    selected ids (≤ 500, chunked). It sends `install-update` only to devices whose
    `update_state` is `ready` for the offered version, and returns the skipped ones with reasons.
  - Release publish and revoke: `requireSuperAdmin`. Releases are platform data, not tenant data.
  - Negative tests: another organization's device or workstation ids; a staff member without
    `settings`; a device not in `ready`; a revoked release; a revoked device token.
- **Storage:** a new R2 bucket such as `labkiosk-releases`. R2 has no egress fees. Serving
  through the Worker ties downloads to an enrolled device, which fits the license terms.
- **The hub** pushes `release-available` (which starts the download) and `install-update` (the
  approval). It relays download progress to the console live, the same way it relays status.

### 5.8 Build and release

- `build-iso.yml` also uploads `binary/live/`, `manifest.json` and its signature to R2, and
  records the release. A super admin publishes it to `beta` or `stable`.
- The security rebuild pipeline in §7 produces patch releases marked `security`.
- Make the squashfs as reproducible as live-build allows (`SOURCE_DATE_EPOCH`, stable file
  order). This matters only for delta updates later (§11).

---

## 6. Relationship to Android A/B updates

| Android | Lab Kiosk equivalent |
|---|---|
| `system_a` / `system_b` partitions | two image folders on the existing ROOT partition; no new partition, no fixed size |
| `update_engine` downloads in the background | `labkiosk-update` background download (§5.4) |
| user taps "Restart to update" | admin clicks **Install update** for selected workstations (§5.5) |
| bootloader gives the new slot one try | GRUB `next_tries=1` |
| `markBootSuccessful()` | `labkiosk-boot-ok.service` |
| automatic fallback | GRUB boots `current` when the try is spent |
| vendor-signed payload, rollback index | signed manifest, `securityFloor` |
| monthly security patch = rebuilt image | security rebuild pipeline (§7) |
| delta payloads | later, after measuring (§11) |
| dm-verity / Verified Boot | later. Needs our own Secure Boot chain; today the image uses Debian's shim and GRUB |
| Virtual A/B snapshots | not needed; two full images fit on an 8 GB disk |

---

## 7. Debian security updates

### Why not `apt upgrade` on each workstation

- **It doesn't persist.** The root is a RAM overlay (invariant 2). An upgrade vanishes at power
  off, and would be downloaded again at every boot.
- **Making the root writable to fix that** loses the property the product is built on. Every
  workstation would then drift to its own mix of package versions.
- **There's no rollback.** A `dpkg` run interrupted by a power cut, or a bad maintainer script,
  leaves a half-upgraded system with nobody at the keyboard (invariant 9).
- **The download isn't smaller**, and none of the result would have been tested before it
  reached the machines.

### The pipeline

1. **Watch.** A daily CI job compares the image's package list (live-build's
   `chroot.packages.live`, published with every release) against the Debian security archive,
   and against the LTS archive while the base is Debian 12.
2. **Rebuild** with a patch version (`2.7.0` → `2.7.1`), marked `security`. No source change is
   needed, because live-build fetches current packages on every build. *Check that the build
   pulls from the security archive:* `auto/config` relies on live-build's default.
3. **Test.** Boot the new image in QEMU with the same health check as `labkiosk-boot-ok`.
4. **Publish.** Workstations download it automatically. It installs when an admin approves, or
   in the nightly window if the organization turned on automatic security installs.
5. **Report.** The console shows which workstations still run a vulnerable Chromium or kernel.

### Debian 12 is on LTS now

- Debian's news page of 12 July 2026 announces that security support for Bookworm was handed
  over to the LTS team. Reports put the end of LTS at June 2028.
- LTS covers a *subset* of packages. Search results show Chromium still being patched for
  Debian 12 in July 2026 (DLA-4672-1). *I couldn't open Debian's sites from this environment to
  confirm the scope.*
- **Move the base to Debian 13 (trixie).** With this update channel, that's one more image
  with a larger test pass, not a re-flash.

---

## 8. Moving the v2.5.0 fleet

1. Release N (the first OTA release) ships the updater, the image-store installer, the §5.2
   state moves, and the Worker and console changes.
2. **Installed v2.5.0 disks must be reinstalled once** from the release N ISO. They have no path
   to receive code, and installing over them is refused by design. Enrolment and Wi-Fi carry
   across as they do today.
3. From release N+1 on, updates arrive over the air and install on approval.

---

## 9. Phased plan

| Phase | Deliverable | Verify with |
|---|---|---|
| 1 | Image-store installer; §5.1 knock-on fixes; §5.2 state moves; GRUB one-try boot; `labkiosk-boot-ok` | QEMU + OVMF and SeaBIOS: install, switch images, force a failed health check, see the fallback; time a full install |
| 2 | Signed manifest in CI; R2 upload; `labkiosk-update` download and install run by hand | QEMU: power cut mid-download, tampered signature, downgrade rejected |
| 3 | D1 migration; device and approval routes with negative tests; console states and **Install update**; the update curtain in the extension; hub messages | `pnpm test`; drive the console in a browser; a two-VM approval against `pnpm dev` |
| 4 | Security rebuild pipeline; "security update waiting" banner; optional nightly auto-install | a week of scheduled builds on a test organization |

The Docker simulator can't exercise GRUB, live-boot or image switching. It can exercise the
download, the update curtain and the reporting against the dev server.

---

## 10. The app-only channel, if it is ever needed

If one full image per release costs too much uplink (45 workstations × 719 MiB ≈ 32 GiB), add a
smaller channel for releases that touch only `/opt/labkiosk` and `/usr/local`. It would be a
signed squashfs of hundreds of KB, stored in the image store and bind-mounted read-only at boot.
Given the 20/19 commit split and the regular Chromium rebuilds, most releases would still need
the full image, so measure before building this.

---

## 11. Bandwidth, later

1. Download windows and rate caps (already in §5.4).
2. Chunk-level delta against the running image (casync-style, or RAUC's adaptive updates). This
   needs a reproducible squashfs; judge it on a measured delta between two real builds.
3. A LAN cache: one workstation per site downloads, the others pull from it.

---

## 12. Open questions and unverified points

- **Approval permission.** `settings`, as proposed, or a new dedicated permission? A new
  permission changes staff delegation (invariant 5) and needs its own migration.
- **Install duration.** "A few minutes" is an estimate: verifying about 700 MiB, one reboot,
  and the health-check hold. Measure it on a slow disk in phase 1.
- **Squashfs size and minimum disk.** Two images at about 719 MiB each need about 1.5 GiB. The
  installer's current 3 GB minimum leaves ROOT at about 1.9 GiB, with no room for growth, so
  **raise the minimum to 8 GB**. Measure `binary/live/` first.
- **`gpgv` in the built image.** Expected because of `apt`, but not checked.
- **Debian 12 LTS scope, and Chromium within it.** This comes from search results, not from
  Debian's pages. It decides how urgent the move to Debian 13 is.
- **Whether live-build pulls from the security archive by default.** Confirm against a built
  image's `chroot.packages.live`.
- **live-boot with `live-media=` pointing at an internal ext4 partition.** `live-media-path=`
  is documented and GParted Live uses this pattern from a hard disk, but it's untested on this
  image. Prototype it first.

---

## Sources

- Repository: `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`,
  `…/opt/labkiosk/agent/agent.py`, `…/opt/labkiosk/extension/content.js`,
  `…/etc/openbox/autostart`, `…/etc/overlayroot.conf`,
  `distro-builder/config/hooks/live/01-lockdown.hook.chroot`, `distro-builder/auto/config`,
  `.github/workflows/build-iso.yml`, `cloudflare-control/src/db.ts`, `cloudflare-control/wrangler.jsonc`,
  `.agents/skills/labkiosk-control/SKILL.md`
- [GitHub release v2.5.0](https://github.com/akbhoi/labkiosk/releases/tag/v2.5.0) (ISO asset size)
- [Overlay Filesystem — Linux kernel documentation](https://docs.kernel.org/filesystems/overlayfs.html)
- [rauc in Debian bookworm](https://packages.debian.org/bookworm/rauc),
  [rauc-service in bookworm](https://packages.debian.org/bookworm/rauc-service)
- [RAUC examples (GRUB boot selection)](https://rauc.readthedocs.io/en/latest/examples.html)
- [Debian bug #1049923: request to include systemd-sysupdate](https://www.mail-archive.com/pkg-systemd-maintainers@alioth-lists.debian.net/msg08611.html)
- [live-boot(7), bookworm](https://manpages.debian.org/bookworm/live-boot-doc/live-boot.7.en.html),
  [GParted Live on a hard disk](https://gparted.org/livehd.php)
- [Debian news, 12 July 2026: security support for Bookworm handed over to the LTS team](https://www.debian.org/News/2026/20260712),
  [Linuxiac: Debian 12 moves to LTS, support to 2028](https://linuxiac.com/debian-12-bookworm-moves-to-lts-extending-security-support-to-2028/),
  [DLA-4672-1 chromium (Debian 12 LTS)](https://linuxsecurity.com/advisories/deblts/debian-dla-4672-1-chromium)
