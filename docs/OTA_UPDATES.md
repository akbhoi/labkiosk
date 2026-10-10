# Over-the-Air Updates — Research

**Status:** phases 1–5 (§9) implemented: the image-store installer, the §5.1 and §5.2 changes, GRUB's one-try boot and `labkiosk-boot-ok` (phase 1); the signed manifest and `labkiosk-update` (phase 2); the control plane, console approval and update curtain (phase 3, §5.10); the daily security rebuild and security releases at the next boot (phase 4, §5.11); sharing a release on the local network (phase 5, §5.12), not yet timed on a real site. **Scope:** delivering new Lab Kiosk releases to installed
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
3. **Feature releases install only when an admin approves.** In the console, the admin selects
   workstations and clicks **Install update**. Only workstations that already hold the
   downloaded update act on it.
4. **Small security fixes install at the next boot, with no approval.** A signed release marked
   `security` (same features, only rebuilt Debian packages) is staged as soon as it's verified.
   The next time the machine starts, whether that's the morning power-on or an operator reboot,
   it boots the fixed image. The boot is the install, so there's no extra downtime and no lock
   screen beyond a short "Finishing update".
5. **Selected screens lock with a "Getting update" screen** while an approved install runs: verify →
   reboot into the new system → health check → unlock. The download is already done, so this
   takes a few minutes, not the length of a download. Measure the real time in phase 1.
6. **A failed update rolls itself back.** The previous system image stays on disk. If the new
   one doesn't pass its health check, the workstation boots the old one, unlocks, and the
   console shows "Update failed, rolled back".
7. **Workstations on the same LAN share the download** (§5.9). One or two machines per site
   fetch the update from the cloud, and the rest copy it from them over the local network.
   Every piece is checked against the signed manifest, so a peer can't slip in a modified image.

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
| ROOT is an **image store** (§5.1): the installer copies the live medium's `vmlinuz`, `initrd.img` and `filesystem.squashfs` to `images/<version>/` (the version from `/usr/share/labkiosk/version`), and the installed system boots that squashfs through live-boot with `labkiosk.installed=1 noeject panic=10`. Disks installed by earlier releases hold an rsync of the live rootfs instead | `labkiosk-install`, `usr/share/labkiosk/boot/grub.cfg` |
| One-try boot: `boot/grub/grubenv` holds `current`, `previous`, `next`, `next_tries`; GRUB spends the try before it boots `next`. `labkiosk-boot-ok.service` runs `labkiosk-boot-slots check` at every boot: it makes `next` current once the agent and browser stay up, or reboots into the old image, and writes the outcome to `/run/labkiosk-update/status.json`. The agent posts failures, rollbacks and successful installs to `POST /api/devices/boot-report` | `labkiosk-boot-slots`, `agent.py`, `src/boot_report.ts` |
| Reinstalling is refused on an installed disk (`is_live_session()`, keyed on `labkiosk.installed=1` or the legacy `/etc/labkiosk-installed`), and `POST /api/install` returns 400 | `labkiosk-install`, `agent.py` |
| The agent runs as the unprivileged `kiosk` user, restarted in a loop by the Openbox autostart. Its only root paths are two single-binary sudo rules (installer, localization). `labkiosk-boot-slots` has no sudo rule | `etc/openbox/autostart`, `01-lockdown.hook.chroot` |
| The command set is `lock/unlock/navigate/reload/reboot/shutdown/clear-session/mute`, plus `release-available` and `install-update`, which only the hub sends (§5.10). There is no exec path | `agent.py` `execute_command()` |
| Commands already go to **selected workstations or groups** as batches (≤ 500 ids). The extension already draws a full-screen **lock curtain** with a message, in a Shadow DOM | `labkiosk-control` skill; `extension/content.js` |
| D1 stores the image version a boot report names (`client_devices.image_version`, with `update_state`, `update_error`, `update_state_at`). Since phase 3 the agent also reports `imageVersion`, `agentVersion` and its update phase to the hub, kept in `agent_version`, `update_phase`, `update_version`, `update_progress`, `update_detail` | `agent.py` `AGENT_VERSION`; `src/db.ts` `client_devices` |
| At install time nothing is written into a system image. ROOT gets only `boot/grub/` (`grub.cfg` copied verbatim, `grubenv`, `labkiosk-password.cfg` for the boot-menu password, `labkiosk-data.cfg` with the DATA partition's UUID) and `images/<version>/`. The empty `/etc/machine-id` ships in the image; localization lives in `localization.json` on DATA and the agent re-applies it (regenerating the locale) at every start | `labkiosk-install`, `01-lockdown.hook.chroot`, `agent.py` `apply_saved_localization()` |
| `DATA` is mounted at `/etc/labkiosk` by the partition UUID GRUB passes as `labkiosk.data=`, never by label, **owned by `kiosk`**, mode 0700. NetworkManager profiles are bind-mounted from it | `labkiosk-data-generator`, `labkiosk-data-permissions` |
| The live kernel command line pins `timezone=Asia/Kolkata username=kiosk` for live-config; the installed boot menu leaves `timezone=` out | `distro-builder/auto/config`, `usr/share/labkiosk/boot/grub.cfg` |
| v2.5.0 ISO: 753 926 144 bytes (719 MiB). CI publishes it as a GitHub Release on `v*` tags | Release `v2.5.0`, `.github/workflows/build-iso.yml` |
| App layer (`/opt/labkiosk` + `/usr/local`): about 420 KB in source | `du` on `includes.chroot` |
| Of the 39 commits that touched `distro-builder/config`, 20 changed only `/opt/labkiosk` or `/usr/local`. The other 19 changed hooks, package lists, bootloaders, Chromium policy base or Openbox config | `git log` over this repo |
| Worker binds R2 (`labkiosk-audit-archive`, and the optional `RELEASES` bucket `labkiosk-releases`) and D1 (migrations 0001–0027) | `wrangler.jsonc`, `migrations/` |

---

## 3. Constraints the design must respect

- **Invariant 2 (RAM overlay, read-only root)** rules out `apt upgrade` on the device. It would
  write into tmpfs and disappear at power-off.
- **Updating the old rsync layout in place is unsafe.** On a disk installed before the image
  store, the ext4 ROOT is the overlayfs *lower* layer. The kernel documentation says changes to an underlying filesystem
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
  mount unit for `LABKIOSK_DATA`, keeping `nofail`, plus the existing
  `labkiosk-data-permissions` ordering and the `system-connections` bind mount. Pin it to this
  disk's partition UUID (GRUB passes it as `labkiosk.data=`), never the label: a USB stick can
  carry the label.

### 5.2 State that must survive an image swap

Anything the old installer wrote onto ROOT would be lost on the first update. Phase 1 moved it:

| Was on ROOT | Now |
|---|---|
| `/etc/fstab`, `/etc/overlayroot.conf` | `labkiosk-data-generator` in the image mounts DATA by UUID; overlay from live-boot |
| `/etc/labkiosk-installed` | `labkiosk.installed=1` on the command line |
| `/etc/grub.d/01_labkiosk_password` | `boot/grub/labkiosk-password.cfg` on ROOT, outside every image. `grub.cfg` is one fixed file that sources it, so nothing regenerates the menu |
| Timezone, locale, keyboard, NTP (written with `--root`) | the agent applies them at every start from `DATA/localization.json` with `labkiosk-localization`, which regenerates the chosen locale when it is missing |
| empty `/etc/machine-id` | shipped empty in the image; regenerated into RAM at every boot |

Config on `DATA` is shared by every image, so **after a rollback the older release will read
config written by the newer one.** Config changes must be additive: new keys may be added, but
existing keys must never be renamed or change meaning.

### 5.3 Payload, manifest and signing

- **Payload:** `filesystem.squashfs`, `vmlinuz` and `initrd.img` from the CI build's
  `binary/live/` (the same bits as the ISO), plus `manifest.json`:
  `{version, channel, kind, baseVersion, files: [{name, size, sha256, chunkSize, chunks: [sha256…]}], securityFloor, builtAt}`.
  - `kind` is `feature` or `security`.
  - Per-chunk hashes (for example 8 MiB chunks) let a device check each piece it gets from a
    LAN peer before it writes it (§5.9).
- **What counts as a `security` release is decided by CI, never by the device or the Worker.**
  CI marks a release `security` only when it is a rebuild of the **same source commit** as
  `baseVersion` and differs only in Debian packages from the security or LTS archive. The kind
  is inside the signed manifest, so the control plane can't relabel a feature release as a
  security fix to skip approval.
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
when the hub announces a release. Phase 3 has no timer (§5.10).

```text
1. GET /api/devices/update         → the release offered to this organization, or nothing
2. Already running or downloaded it → exit
3. Fetch manifest + signature; verify; enforce securityFloor
4. Remount ROOT rw; delete the image that isn't running; fetch chunks into downloads/<version>/
   from LAN peers first (§5.9), then the cloud with HTTP Range resume, a bandwidth cap and a
   random start delay; check each chunk's hash before writing it; fsync; remount ro
5. Verify every file's sha256 again from disk; write .verified; rename the folder to
   images/<version>/
6. kind = security for the running line → stage it for the next boot (§5.5)
   kind = feature                        → report "ready <version>" and wait for approval
```

- **The kiosk keeps working throughout.** Nothing is locked, nothing reboots, and the running
  image is never touched.
- **A newer release before approval** simply replaces the downloaded one. There's only ever one
  update waiting.
- **The uplink is spread out.** A random start delay, an optional per-organization download
  window (for example 18:00–07:00), and a rate cap stop 45 machines from saturating the line
  at once.
- **A power cut mid-download** leaves an unverified folder in `downloads/`. GRUB never boots it:
  only approval can point `next` at an image, approval requires `.verified`, and GRUB's last
  resort, which boots any complete folder in `images/`, never sees `downloads/`. The next run
  re-checks the chunks already on disk and resumes after the last good one.
- **Live USB sessions** don't download. They have no image store. The console shows them as
  "live session, update by re-flashing".

### 5.5 Admin approval and the "Getting update" screen

**In the console.** The Workstations view shows a column per machine:

| State | Meaning |
|---|---|
| Up to date · 2.6.1 | nothing waiting |
| Downloading 2.7.0 · 63 % | in progress, kiosk unaffected |
| **Ready to install 2.7.0** | feature release verified on disk, waiting for approval |
| **Installs at next restart · 2.7.1** | security release staged; takes effect at the next boot |
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
- **Permission:** approving an install needs the `updates` permission (phase 3), since it
  changes the operating system of the organization's machines. The `workstations` permission,
  used for daily lock and navigate, isn't enough. Approvals go in the audit log
  (`update.install`: who, when, which machines, which version).

**Security releases install at the next boot, without approval.**

- Once a `security` release for the running line is verified on disk, the root updater sets
  `next=<v>`, `next_tries=1` in `grubenv` straight away. It writes nothing else and doesn't
  reboot.
- The machine keeps working on the current image until it next starts: the morning power-on,
  an operator's `reboot`, or a power cut. GRUB then boots the fixed image once. The health
  check and rollback in §5.6 apply exactly as for an approved install.
- The agent shows a short "Finishing update" curtain until the health check passes. There's no
  "Getting update" screen, because nothing needs to run before the reboot.
- **The console shows "Installs at next restart · 2.7.1"** per machine. An admin who wants it
  now can use the existing **Reboot** command on the selected workstations.
- **Machines that never restart.** A kiosk left on for weeks never picks the fix up. The
  console flags machines whose staged security release is older than N days, so the admin can
  reboot them.
- **Organization setting `security_updates`:** `next_boot` (default) or `approval`, for
  organizations that want to approve every change. With `approval`, security releases behave
  like feature releases, and the console shows a banner when one has been waiting more than
  N days.
- **When a security fix and a feature release compete for the spare folder:** there's only one
  spare image folder. A security fix for the running line takes it first and installs at the
  next boot. After that, the feature release downloads into the spare folder, replacing the old
  rollback image, and waits for approval as usual. A security fix never waits behind an
  unapproved feature release.
- **Which lines get security rebuilds:** CI rebuilds the **latest two** release lines (for
  example 2.7.x and 2.8.x). An organization that hasn't approved 2.8 yet still gets fixes on 2.7.

### 5.6 Boot selection and rollback

`grubenv` holds `current`, `previous`, `next`, `next_tries`:

- **Normal boot:** boot `current`.
- **After approval, or once a security release is staged:** `next=<v>`, `next_tries=1`. GRUB decrements the counter and boots `next`
  once. If it's already `0`, GRUB boots `current` and leaves `next` so the old image can report
  the failure.
- **Health check passes:** `previous=current`, `current=next`, clear `next`.
- GRUB can write `grubenv` on ext4. It can't on LVM, RAID or compressed btrfs, none of which this
  layout uses. The environment block is a fixed 1 KiB, rewritten in place, so a power cut
  during a write can't corrupt the filesystem.
- **The health check is local.** It doesn't wait for the control plane, so an organization that
  is offline at boot doesn't roll back a healthy image.

### 5.7 Control plane

*Phases 3 to 5 built a subset of this plan; §5.10 to §5.12 say what exists. The download window
and rate limit settings and the Worker file route are not built, and LAN sharing keeps who is
where in the organization's hub instead of the `client_devices` columns below (§5.12).*

- **D1 (a new migration, 0019 or later, and `SCHEMA_SQL`):**
  - on `client_devices`: `agent_version`, `update_version`, `update_progress`, and for LAN
    sharing `lan_address`, `egress_ip`, `peer_port`. Phase 1 already added `image_version`,
    `update_state`, `update_error` and `update_state_at` (migration 0015), with
    `POST /api/devices/boot-report`: each installed boot's outcome (installed, failed, rolled
    back, fallback, error) is kept there, and problems are listed in `workstation_issues`
    (migration 0016, Settings → Errors & Warnings), so a failed update is visible in the console
    before phase 3's update states exist;
  - platform table `releases`: `version`, `channel`, `kind`, `base_version`, `manifest`,
    `signature`, `r2_prefix`, `size_bytes`, `published_at`, `revoked_at`;
  - organization settings: `update_channel` (`stable`/`beta`), `download_window`,
    `download_rate_limit`, `security_updates` (`next_boot` default, or `approval`),
    `lan_sharing` (on or off; §5.9).
  - None of these are CHECK changes on a parent table. Confirm with `labkiosk-d1-schema`.
- **Routes (each with a guard and negative tests):**
  - `GET /api/devices/update` (`requireDevice`): the release offered to this device's
    organization, plus this device's role (`seed` or `peer`) and peer list for LAN sharing (§5.9).
    The peer list only ever contains devices from the same organization.
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

### 5.9 Sharing updates on the local network

**Goal:** a site with 45 workstations fetches the update from the internet once or twice, not 45
times. The rest travel over the LAN, which is usually 10 to 100 times faster than the uplink.

**Finding peers — the Worker coordinates, no multicast.**

- The agent reports its LAN address and prefix; today it works out the address but doesn't
  send it. The Worker records the public IP each device connects from (`CF-Connecting-IP`,
  which it already reads for other purposes).
- Devices in the **same organization** with the **same public IP** and the **same LAN subnet**
  count as one site.
- mDNS or broadcast discovery is deliberately not used:
  - the image ships without Avahi (removed to keep the ISO small);
  - multicast often doesn't cross VLANs or managed Wi-Fi;
  - it would let any device on the LAN pose as a peer.

**Who downloads from where.**

1. For each site, the Worker picks one or two **seeds**, preferring online, wired, idle
   machines. Seeds download from the cloud as in §5.4.
2. Every other machine is told it's a **peer** and given the site's peer list. It waits for a
   seed to finish, then copies the image from the nearest machine that has it.
3. **Every machine that finishes starts serving too**, so copies double each round:
   1 → 2 → 4 → … 45 takes about six rounds.
4. **Fallback to the cloud:** if no peer delivers within a couple of minutes, or peers can't
   reach each other, the machine downloads from the cloud itself. Peers are often blocked by
   Wi-Fi client isolation or VLAN rules. A machine is never stuck waiting on the LAN.

**Speed, estimated rather than measured:** one 719 MiB copy takes about 7 s at full gigabit
and about 70 s on 100 Mbit. In practice a slow disk or eMMC is often the limit. Allowing for
that and the doubling, a whole site should finish in minutes once the seed has the image.
Phase 5 did not measure it (§5.12).

**Security: the only new thing listening on the network.** Today every listener is
loopback-only (invariant 8), so this needs its own guard rails:

- **A separate, small server** (`labkiosk-share`), not the agent and not root. It runs as its
  own unprivileged user with read access to the image folders only. It can't read `DATA`, so
  device tokens, Wi-Fi keys and config never leave the machine.
- **Only exact reads:** it answers only `GET /<version>/<file>/<chunk>` for a version that is
  `.verified` on this machine. No listing, no other paths, no writes.
- **LAN only:** it answers only private or link-local source addresses in its own subnet. Add
  `nftables` to the image to enforce the same rule in the kernel. The image has no firewall
  today, so this is a new package.
- **Integrity doesn't depend on trusting peers.** Every chunk is checked against the hash in
  the signed manifest before it's written. A broken or malicious peer can only waste time; it
  gets dropped for that download, and the failure is reported.
- **Nothing secret is served.** Images are the same bits as the public release ISO.
- **Short-lived:** the server runs only while a release is spreading, meaning until every
  machine on the site has it, or 48 hours at most. Otherwise the port is closed.
- **Polite:** a few uploads at a time, at low I/O priority, so a machine that is serving
  stays responsive for its user.

**Start simple.** Machines serve only complete, verified images. Serving partial downloads
chunk by chunk (BitTorrent-style) would only shave off the first round; add it only if
measurements show the first round is the bottleneck. The per-chunk hashes are needed from the
start anyway, to check what peers send.

**Alternatives considered:**

- **A BitTorrent client:** a large new daemon. Its local peer discovery is multicast, and
  trackers and DHT would have to be disabled. The Worker already knows everything a tracker
  would.
- **aria2 with Metalink:** fetches from several HTTP mirrors in parallel with piece hashes. It
  would be a reasonable download engine, but it's still a new package, and it's no help with
  finding peers.
- **The organization's HTTP proxy cache:** downloads are per-device, authenticated and over
  HTTPS, so a shared proxy can't cache them.
- **An on-site cache server:** works, but asks the organization to run a machine. Peer sharing
  needs nothing extra.

### 5.10 What phase 3 built

**Releases (super admin).** CI uploads each signed release to the R2 bucket bound as
`RELEASES` (`labkiosk-releases`) under `releases/<version>/`. The **Releases** tab of the Super
Admin console (`/super/releases`, `GET /api/super/releases`) records any new folder whose
`manifest.json` parses and has `manifest.json.sig` beside it, in the platform table `releases`
(migration 0027; no `tenant_id`). A release reaches no workstation until a super admin
classifies it **Beta** or **Stable**; **Withdraw** takes it out of its channel, and **Revoke**
withdraws it for good. Each change is audited (`release.classify`, `release.revoke`) and every
organization's hub reloads its offer.

**The offer.** An organization's `update_channel` (`stable` by default, or `beta`, in
Settings → Updates) decides what it is offered: the newest unrevoked `stable` release, and on
`beta` also `beta` ones. `GET /api/devices/update` (device token) returns that release and the
folder to download it from: `RELEASES_BASE_URL` (the bucket's public address) plus
`releases/<version>`, or 503 when that variable is unset or not https. Workstations download
from that public address, not through the Worker; the signature, not the address, is what they
trust.

**On the workstation.** No timer runs anything.

- The agent reports `imageVersion`, `agentVersion` and `update` (`{phase, version?, progress?,
  detail?}`, phases `live`, `idle`, `checking`, `downloading`, `ready`, `installing`,
  `up-to-date`, `error`) in its hub status. The updater writes the phase to
  `/run/labkiosk-update/update.json` (root-owned, 0644); a live session reports `live`.
- The hub sends `release-available` when a workstation runs an image older than the offer and
  isn't already fetching or holding it: on connect, on a status change and on a config change,
  at most every 10 minutes (60 after an error). The console's **Check for updates** sends it
  too.
- On `release-available` the agent starts `labkiosk-update-download.service`
  (`labkiosk-update run`, `Nice=10`, idle I/O). `run` reads `workerUrl` and `deviceToken` from
  `config.json` and the proxy from `proxy.json`, both checked with the agent's own validators,
  asks `GET /api/devices/update`, and downloads with the phase 2 code. A live session never
  starts it.
- **Install update** in the console (`POST /api/clients/install-update`, `updates` permission)
  sends `install-update` only to selected workstations that are online and report `ready` for
  the offered version; the rest come back with a reason (offline, live session, still
  downloading, too old to update over the air, and so on) and are never updated later on their
  own. The agent checks the version it holds equals the command's and starts
  `labkiosk-update-install.service`: `install-pending` gives that release its one try at the
  next boot, then the unit reboots.
- The kiosk bar shows an update curtain, "Installing a system update", and "Finishing a system
  update" while the new image's boot check runs. It is separate from the operator's lock, so
  `unlock` leaves it, and `reboot` and `shutdown` are refused while installing. An install
  error, or no restart within 15 minutes, takes it down.
- Both units carry `ConditionKernelCommandLine=labkiosk.installed=1` and are not enabled. A
  polkit rule (`/etc/polkit-1/rules.d/50-labkiosk-update.rules`, from `01-lockdown.hook.chroot`)
  lets `kiosk` start exactly these two units and nothing else.
- `POST /api/command` never accepts `release-available` or `install-update`.

**Console.** Each workstation card shows its image version and update phase. The Workstations
toolbar has an **Updates** menu (**Check for updates**, **Install update**) for accounts holding
`updates`, and the Staff page has an **Updates** permission.

**Getting there.** Disks installed before this release have neither the units nor the polkit
rule and need one reinstall from the 2.9.0 ISO (§8). A live USB session is updated by
re-flashing.

Phase 4 is §5.11 and phase 5 is §5.12.

### 5.11 What phase 4 built

**The security rebuild** (`.github/workflows/security-rebuild.yml`, §7). Every day at 06:00 IST,
and by hand (one line, `force`, `dry_run`):

1. From the repository's tags, the latest two stable lines from 2.9 on and the newest tag of each
   (`distro-builder/tools/security-rebuild.py lines`). An older line has no updater, so nothing
   rebuilt for it could reach a workstation.
2. The installed packages of that tag's image (`var/lib/dpkg/status`): the `dpkg-status` its GitHub
   release carries when it is a security release, otherwise read from the squashfs of its ISO
   (checked against its `.sha256`); cached by tag.
3. Compared with Debian's `bookworm-security` `Packages` indices (`check`; Debian version order as
   `dpkg --compare-versions`, tested against dpkg itself). Nothing newer, nothing built.
4. Otherwise the tag's own source, with only its version raised one patch in the four files that
   carry it (`bump`), committed and tagged locally, built with the builder image of that tree.
5. The new image's packages are checked again (`check --fail-if-outdated`): an image still missing
   a fix the archive has is refused, as one built without the security archive would be.
6. That release's own `boot-test.sh`, then signed like a tag build but with
   `make-release-manifest.py --kind security --base-version <base>`; the security floor stays the
   base's.
7. R2 (`releases/<version>/`, never overwritten), the tag pushed with `GITHUB_TOKEN` (which starts
   no other workflow, so `build-iso.yml` never builds it again), the GitHub release with the
   changed packages as its notes (`notes`) and the image's `dpkg-status`, and the `/download`
   sync. The ISO is built and boot-tested but not published: workstations take the image from
   R2, and a new install starts from the newest feature release's ISO and is offered the
   security release for its line. So the GitHub release is never "Latest", and `/download`
   offers the newest release that has an ISO, listing security releases by version beside it.

A super admin classifies the rebuild on the Releases page like any release; nothing reaches a
workstation before that.

**The offer.** `GET /api/devices/update?running=<image version>` adds `security`, the newest
classified `security` release for the line (major.minor) the workstation runs, newer than it, and
`securityUpdates`, the organization's `tenants.security_updates` (`next_boot` by default, or
`approval`; migration 0029, Settings → Updates). `release` is unchanged, so a 2.9.0 updater, which
sends no `running`, works as before.

**On the workstation.** `labkiosk-update run` fetches the `security` release before the newest
one (a fix never waits behind an unapproved feature release, and replaces a downloaded one).
When the release's **signed manifest** says `kind: security` for the running line and the setting
is `next_boot`, it gives the release its one try at the next boot straight away (`install`:
`next=<v>`, `next_tries=1`; no reboot) and reports `staged`, with the manifest's `kind` and
`since`, when this boot first held it. The boot that follows is the install: GRUB's one try, the
"Finishing a system update" curtain and the health check of §5.6, with rollback. A staged release
is not written again on later runs; one that rolled back is never staged again by itself (the
console shows the error; with `approval` an administrator can still install it). With `approval`,
or a control plane that sends no setting, the release stays `ready` like a feature release. The
Worker can therefore delay a security release but never make a feature release install itself.

**The hub** reminds a workstation of the release meant for it (`updateTargetFor`): the security
release for its line, else the newest. A `staged` workstation is left alone; one holding a
security release `ready` is reminded once its organization switches to `next_boot`, so it stages
it. An updater from before phase 4 never reports `kind` and only fetches the newest release;
holding that, it is left alone. **Install update** sends each workstation the version meant for it
and refuses a `staged` one ("Installs at its next restart; restart it to install now").

**Console.** A workstation card shows "*v* installs at next restart", and in amber "…not restarted
in *N* days" once it has waited 7 days (`SECURITY_WAIT_WARN_DAYS`), for **Reboot** to fix; with
`approval`, "security fix *v* ready to install". Settings → Updates has the **Security fixes**
choice and, per line, the newest security release some workstations do not run yet with how many
and since when, in amber after 7 days. The change is audited as `settings.security_updates`.

**Which images stage.** The updater in an image decides, so staging starts with the first feature
release that carries phase 4. A 2.9.x image, and its security rebuilds (built from 2.9.x source),
take security releases on approval.

### 5.12 What phase 5 built

Off by default: an organization turns it on under Settings → Updates (**Share updates on the
local network**; `tenants.lan_sharing`, migration 0030; audited as `settings.lan_sharing`).

**On the workstation.** The agent reports `lan` in its status, `{address, prefix}`: the private
IPv4 address of the interface its default route uses, from `ip -j` (10/8, 172.16/12 or 192.168/16,
prefix 16 to 30; anything else reports nothing and the workstation never shares). The hub config
carries `lanSharing`; when it turns false the agent stops `labkiosk-share.service` (polkit lets
`kiosk` stop that unit, never start it).

**Who goes first** (`src/lan_sharing.ts`, `OrgHub`). A site is one organization, one public
address (`CF-Connecting-IP`; an IPv6 address by its /64) and one reported subnet, all live on the
hub's sockets; nothing about it is written to D1. When the hub tells a workstation of a release,
it holds it back while two others at its site (`LAN_SEEDS_PER_SITE`) are fetching it, or were
told of it in the last 5 minutes, and none holds it yet. A held workstation shows "waiting to copy
the update nearby" on its card, and is told as soon as a site member holds the release, a seed
drops out, or 60 minutes pass (`LAN_HOLD_MAX_MS`), whichever is first. **Check for updates** goes
through the same hold (the hub's `/check-update`).

**The offer.** `GET /api/devices/update` adds `lan`: `null` when the organization does not share,
else `{peers}`, up to 8 LAN addresses of site members that report the release `ready` or `staged`
in this boot within the last 48 hours, in random order so copies spread across every holder.

**Fetching.** `labkiosk-update run` tries up to 3 peers at `http://<peer>:8890/<version>/` (no
proxy; 15 s without data drops a peer), then the cloud. It is the same `download()` as from R2: the
manifest's signature, then every chunk against the signed manifest, and a peer whose signed
manifest names another version is refused before anything is written. Verified chunks are kept,
so the next source resumes where a dropped peer stopped. Once the release is `ready` or `staged`
and the offer's `lan` is not null, it starts `labkiosk-share.service`; a run with `lan: null`, or
48 hours after this boot first held the release, stops it.

**`labkiosk-share`.** A unit that is never enabled, as a dynamic user that cannot read
`/etc/labkiosk`, for at most 48 hours a start (`RuntimeMaxSec`), at idle I/O priority. Before it
starts, `labkiosk-share.nft` (the new `nftables` package) accepts TCP 8890 only from 10/8,
172.16/12 and 192.168/16 and drops the rest; the table is deleted when it stops. The server
answers only its own subnet, `GET`/`HEAD /<version>/<file>` with one `Range`, for a version whose
`.verified` matches its manifest and whose manifest is valid, for `manifest.json`, its signature
and the files it lists at their listed size, never through a symbolic link. Four uploads at a time;
a fifth is told 503 and tries another peer or the cloud.

**Differences from §5.9.** Whole files with `Range`, not a chunk path; no link-local peers; the
server stops after 48 hours rather than when the site is done; the cloud fallback is per peer
(15 s of silence), with the hub's 60-minute hold as the bound on waiting; seeds are the first
workstations told, not chosen as wired or idle.

**Not done.** The timing of §9 (5 to 10 VMs on one virtual LAN with a throttled uplink) has not
been run; the unit tests cover a corrupted or foreign peer, an unreachable one and a busy one.

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

*Built in phase 4; §5.11 has the details.*

1. **Watch.** A daily CI job compares the image's installed packages (its dpkg status, read from
   the release's ISO, or the `dpkg-status` a security release publishes) against Debian's `bookworm-security` archive. Debian LTS publishes to the
   same suite, so this covers LTS while the base is Debian 12.
2. **Rebuild** with a patch version (`2.9.0` → `2.9.1`), marked `security`. No source change is
   needed beyond the version, because live-build fetches current packages on every build.
   *Checked:* the v2.9.0 image's `/etc/apt/sources.list` lists `bookworm-security`, which
   live-build adds by default, and its Chromium is the security archive's
   `154.0.8037.92-1~deb12u1`. Each rebuild is checked again: one still missing a fix is refused.
3. **Test.** The release's own `boot-test.sh` in QEMU, as for a tag build.
4. **Publish.** Once a super admin classifies it, workstations download it automatically (later
   sharing it over the LAN, §5.9) and boot it at their next start, unless the organization chose
   `approval` for security releases.
5. **Report.** Settings → Updates lists, per line, how many workstations do not run the newest
   security release yet; each card says when one is staged, and since how many days.

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

Release N is 2.9.0, the first with phase 3. A disk installed by an earlier release, phase 1 or 2
included, lacks the update units and the polkit rule (§5.10), so it too is reinstalled once.

---

## 9. Phased plan

| Phase | Deliverable | Verify with |
|---|---|---|
| 1 | **Done.** Image-store installer; §5.1 knock-on fixes; §5.2 state moves; GRUB one-try boot; `labkiosk-boot-ok`; boot reports to the console | `distro-builder/tests/vm/boot-test.sh` in `build-iso.yml` after every ISO build (QEMU + OVMF + KVM): install, promote a new image, a broken squashfs, recovery, an image whose kiosk never comes up. BIOS boot is covered only by the GRUB menu unit tests; a full install has not been timed |
| 2 | **Built.** Signed manifest in CI; R2 upload; `labkiosk-update` download and install run by hand | `distro-builder/tests/test_update.py` (resume, a damaged partial, tampered and foreign signatures, the floor, install re-verification); `boot-test.sh` scenarios 5–9: a download killed mid-squashfs is never booted and resumes, a tampered manifest and a signed downgrade are refused with nothing written, the finished download installs and is promoted. The download runs from the host against the mounted disk (the kiosk has no shell), so the "power cut" is a killed process, not a VM power cut |
| 3 | **Built** (§5.10). Migration 0027; `GET /api/devices/update`, the console's check and install routes and the super admin Releases page, with negative tests; console update states and **Install update**; the update curtain; hub messages; `labkiosk-update run` / `install-pending` and their two units | `pnpm test`; `distro-builder/tests/test_update.py` and `test_client.py`; drive the console in a browser; a two-VM approval against `pnpm dev` |
| 4 | **Built** (§5.11). `security-rebuild.yml` (latest two lines) and `tools/security-rebuild.py`; `make-release-manifest.py --kind security`; migration 0029 and `tenants.security_updates`; the `security` offer; `labkiosk-update run` staging for the next boot; the "installs at next restart", "not restarted in N days" and pending-fix console states | `distro-builder/tests/test_security_rebuild.py` (Debian version order against dpkg) and `test_update.py` (staging, approval, a mislabelled release, rollback, replacement); `pnpm test`; drive the console in a browser; the workflow by hand with `dry_run`, then a week of scheduled runs on a test organization |
| 5 | **Built** (§5.12), not yet timed. Migration 0030 and `tenants.lan_sharing`; LAN address reporting, site grouping and seed choice in the Worker; `labkiosk-share` with `nftables`; cloud fallback | `distro-builder/tests/test_lan_sharing.py` (the server's paths, ranges and subnet, a corrupted or foreign peer, an unreachable one, the 48-hour stop) and `pnpm test` (sites, seeds, the hold, peers); drive Settings → Updates in a browser. Still to do: 5–10 VMs on one virtual LAN with a throttled uplink; time the whole site; a peer that serves corrupted chunks; client isolation (peers unreachable) |

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
3. LAN sharing is designed in §5.9. Chunk-level swarming is the next step after it, if needed.

---

## 12. Open questions and unverified points

- **Approval permission.** Answered in phase 3: a new staff permission, `updates`, which
  `org_admin` holds by default. `settings` alone does not grant it.
- **LAN sharing default.** Answered in phase 5: opt-in per organization, off by default. It is
  the first listener on the LAN.
- **Security rebuilds for two release lines** double that CI job's runtime when both need one.
  Built with two (`LINES_KEPT`); confirm it is the right support window.
- **Install duration.** "A few minutes" is an estimate: verifying about 700 MiB, one reboot,
  and the health-check hold. Phase 1 did not measure it; time it on a slow disk.
- **Squashfs size and minimum disk.** Answered in phase 1: the installer now refuses disks
  under **7 GiB**, counted in GiB so that a drive sold as "8 GB" still qualifies. Two images at
  about 720 MiB each fit with room to grow; the CI boot test installs onto an 8 GiB disk.
- **`gpgv` in the built image.** Answered: the v2.9.0 image's dpkg status lists `gpgv`
  installed (`Priority: important`).
- **Debian 12 LTS scope, and Chromium within it.** This comes from search results, not from
  Debian's pages. It decides how urgent the move to Debian 13 is.
- **Whether live-build pulls from the security archive by default.** Answered in phase 4: it
  does (§7), and every security rebuild checks its own result against the archive.
- **live-boot with `live-media=` pointing at an internal ext4 partition.** Answered in
  phase 1: installed disks boot this way (by the partition's UUID, the label only as a
  fallback), and the CI boot test exercises it under UEFI after every ISO build.

---

## Sources

- Repository: `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`,
  `…/usr/local/sbin/labkiosk-boot-slots`, `…/usr/share/labkiosk/boot/grub.cfg`,
  `…/etc/systemd/system-generators/labkiosk-data-generator`, `distro-builder/tests/vm/boot-test.sh`,
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
