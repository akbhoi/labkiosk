# Installation Guide

End-to-end, from a blank thin client to a workstation live on a teacher's dashboard. This is the school IT administrator's path.

**Estimated time:** about 15 minutes for the first machine, about 5 for each one after.

---

## Before you start

| You need | Notes |
| :--- | :--- |
| A registered, **approved** school on a Lab Kiosk control plane | Either your own deployment or a hosted one. → [Production Deployment](Production-Deployment) |
| Your school's **enrollment key** | Teacher Dashboard → Settings → Workstation Enrollment Key. Schools start with an empty key, which authenticates nothing — generate one first. |
| The **ISO**, on a USB stick of 2 GB or more | Download it, or → [Building the ISO](Building-the-ISO) |
| Thin clients with at least **2 GB RAM and a 3 GB disk** | 4 GB RAM and a 12 GB SSD is the reference target |

---

## Step 1 — Boot the live medium

Insert the USB stick and boot from it. The menu offers:

| Entry | Use when |
| :--- | :--- |
| **Lab Kiosk OS** | Normal. Boots with the RAM overlay, reading the squashfs from the stick as it goes. |
| **Lab Kiosk OS (Load into RAM - toram)** | You want to remove the USB stick after boot. Needs more RAM than the image size. |
| **Install Lab Kiosk to Hard Disk** | Goes straight to the installer tab in the wizard. |
| **Failsafe** | The graphical entries fail. |

The machine boots straight into the kiosk with no password prompt — every menu entry is marked `--unrestricted`. → [Kiosk Hardening](Kiosk-Hardening#the-boot-menu-password)

You should land on the **first-boot setup wizard**.

---

## Step 2 — Decide the order: enrol first, or install first

Both work, but they are not equivalent.

| Order | What happens |
| :--- | :--- |
| **Install, then enrol** *(recommended)* | The installer creates the `LABKIOSK_DATA` partition. After the reboot you enrol once, and the token persists because `/etc/labkiosk` is on that partition. |
| **Enrol, then install** | The token is copied across with the rootfs. Required on images built *before* the `LABKIOSK_DATA` partition existed, where a post-install enrolment would be lost at the next reboot. |

If you are unsure which image you have, enrol first — it is harmless either way.

---

## Step 3 — Install to the internal drive

In the wizard, open **Install to Hard Disk**.

### Choose the target

The list shows candidate disks of at least 3 GB. **The USB stick you booted from is excluded** — the installer matches it through `/proc/mounts` and `/sys` and refuses it both when listing and again immediately before wiping.

Removable drives are still shown and labelled `REMOVABLE DRIVE`, because internal eMMC on some thin clients reports as removable. They sort last, so the default selection is always an internal disk. Read the label before you continue.

### Set a boot-menu password

Use **Generate** for a random 20-character password, or type your own.

**Record it before installing.** It is hashed in the browser with WebCrypto and only the digest is sent onward; the plaintext never reaches the agent, never appears in a process argument, and is never written to disk. It cannot be recovered afterwards.

If you leave it blank, any password inherited from the live medium is removed, so an unlocked install is visibly unlocked.

A boot-menu password is worth setting. Without it, anyone with physical access can press `e` at the menu, append `init=/bin/sh`, and bypass every other control at once.

### Run it

Click install and watch the progress. The installer will:

1. Partition the disk as hybrid GPT — `bios_grub`, `ESP`, `ROOT`, `DATA`.
2. Format and `rsync` the rootfs across.
3. Truncate `/etc/machine-id` so systemd generates a fresh one on first boot.
4. Configure `overlayroot="tmpfs"` on the installed drive.
5. Install **three** GRUB variants — UEFI, UEFI removable fallback, and legacy BIOS — so the drive boots regardless of firmware mode.

→ [Disk Installer](Disk-Installer) for the full sequence.

### Reboot

Remove the USB stick and reboot. The workstation should come straight up into the kiosk. The wizard now shows only the enrolment form.

---

## Step 4 — Enrol the workstation

| Field | Value |
| :--- | :--- |
| **School subdomain** | e.g. `oakridge` — or your custom domain, if your school has one approved |
| **Workstation identifier** | e.g. `PC-01`. Must match `^[A-Z0-9][A-Z0-9_-]{0,62}$` |
| **Enrollment key** | From Settings → Workstation Enrollment Key |

Click **Connect & Register Workstation**.

The agent validates and probes the control plane URL before storing anything, so a typo fails loudly here rather than producing a workstation that silently never checks in. On success it writes `/etc/labkiosk/config.json` (mode `0600`), syncs the Chromium policy, and restarts the browser once.

That browser restart is necessary: **Chromium reads managed policy only at startup**, so without it a freshly enrolled kiosk sits on a "This page is blocked" screen with a perfectly correct policy on disk.

Within three seconds the workstation appears on the Teacher Dashboard with a live thumbnail.

### Naming convention

`clientId` is what teachers see on the dashboard, so make it match the physical labels on the machines — `PC-01`, `LAB3-07`, `LIB-KIOSK-2`. Changing it later means decommissioning and re-enrolling.

---

## Step 5 — Lock down the firmware

Software cannot defend against someone who simply boots something else.

1. Enter the workstation BIOS/UEFI setup.
2. Set a strong Supervisor/Administrator password.
3. Set the internal drive as the only boot target.
4. Disable the boot-device menu (F12) and USB booting.

---

## Step 6 — Repeat, and verify the lab

For each remaining machine: boot the USB, install, reboot, enrol with the next identifier.

Then, from the teacher dashboard:

- Every workstation shows a live thumbnail and an online indicator.
- **Lock all** raises the curtain everywhere.
- A broadcast navigates the whole lab at once.
- **Reset to portal** brings them back.

---

## Optional — remote control

Interactive remote desktop needs a per-workstation Cloudflare Tunnel, which is not part of the base image because per-machine credentials cannot be baked into a generic ISO.

**Everything else works without it**: live thumbnails, lock curtains, broadcasts, reload, reboot, shutdown, and mute. Only the interactive session requires a tunnel.

→ [Remote Control](Remote-Control)

---

## Re-enrolling or moving a workstation

1. On the teacher dashboard, decommission it (`/api/clients/remove`). This revokes its device token; its next heartbeat gets `401`.
2. On the workstation, clear `/etc/labkiosk/config.json` and reboot. On live media the RAM overlay does this for you at power-off.
3. Run the wizard again with the new school's subdomain and key.

Rotating the enrollment key does **not** affect already-enrolled workstations — they hold their own tokens. Rotation only stops *new* enrolments with the old key.

---

## Troubleshooting first installs

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| No candidate drives listed | Disk under 3 GB, or the only disk is the live medium | Check the disk size; install to a different machine |
| Enrolment rejected | Empty or stale key, or the school is `pending`/`suspended` | Generate a key; have a super admin approve the school |
| "This page is blocked" after enrolling | Chromium has not reloaded policy | Wait for the automatic restart; if it persists, check `/tmp/lab-agent.log` |
| Workstation never appears | Wrong subdomain, no network, or a revoked token | `docker exec`-equivalent: read `/tmp/lab-agent.log` on the machine |
| Boots to a password prompt | An installed disk got `set superusers` without `--unrestricted` | Rebuild; `--unrestricted` must stay unconditional |

→ [Troubleshooting](Troubleshooting) for the full catalogue.

---

## Testing matrix

| Environment | Verifies |
| :--- | :--- |
| **Hyper-V Gen 2 (UEFI)** | GRUB EFI menu, live boot, disk detection, install to VHDX, standalone reboot |
| **VirtualBox (BIOS)** | ISOLINUX menu, live boot, install to VDI, legacy GRUB boot |
| **Docker simulator** | Agent, extension, telemetry — no hardware needed |

→ [Workstation Simulator](Workstation-Simulator) · [Teacher Dashboard Guide](Teacher-Dashboard-Guide)
