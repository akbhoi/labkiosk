# Installation Guide

End-to-end, from a blank thin client to a workstation live on an operator's dashboard. This is the organization IT administrator's path.

**Estimated time:** about 15 minutes for the first machine, about 5 for each one after.

---

## Before you start

| You need | Notes |
| :--- | :--- |
| A registered, **approved** organization on a Lab Kiosk control plane | Either your own deployment or a hosted one. → [Production Deployment](Production-Deployment) |
| Your organization's **enrollment key** | Admin console → Settings → Workstation Enrollment Key. Organizations start with an empty key, which authenticates nothing — generate one first. It is four groups of five characters; the setup wizard inserts the hyphens as you type, and a pasted key is accepted with or without them, in any case, and even with a label copied along with it. |
| The **ISO**, on a USB stick of 2 GB or more | Download it, or → [Building the ISO](Building-the-ISO) |
| Thin clients with at least **2 GB RAM and a 7 GiB disk** (a drive sold as 8 GB qualifies) | 4 GB RAM and a 12 GB SSD is the reference target |

---

## Step 1 — Boot the live medium

Insert the USB stick and boot from it. The menu offers:

| Entry | Use when |
| :--- | :--- |
| **Lab Kiosk OS** | Normal. Boots with the RAM overlay, reading the squashfs from the stick as it goes. |
| **Lab Kiosk OS (Load into RAM - toram)** | You want to remove the USB stick after boot. Needs more RAM than the image size. |
| **Install Lab Kiosk to Hard Disk** | Boots directly into the installer wizard. |
| **Failsafe** | The graphical entries fail. |

The machine boots straight into the kiosk with no password prompt — every menu entry is marked `--unrestricted`. → [Kiosk Hardening](Kiosk-Hardening#the-boot-menu-password)

You will land on **Step 1: Network Setup** of the setup wizard.

---

## Step 2 — Configure the network connection

The setup wizard enforces a **Network First** workflow so that all dependencies and Cloudflare control plane connections are verifiable before attempting installation or enrollment.

### 1. Interface Selection

- **Ethernet:** Automatically detects physical cable link status (`Connected (Cable plugged in)` vs. `Unplugged`).
- **Wi-Fi:** Automatically lists detected wireless interfaces. Click **Scan / Refresh** to view live SSIDs sorted by signal strength with lock badges for encrypted networks. Supports WPA/WPA2/WPA3 Personal (PSK) and Open networks. Use **Join Hidden Network** to specify an unbroadcast SSID.

### 2. IP Addressing (IPv4 & IPv6)

Under **IP Addressing & DNS Configuration (Optional)**:

- **Automatic (DHCP / SLAAC):** Default standard dynamic addressing.
- **DHCP with Custom DNS:** Obtains IP and default route automatically from DHCP, but overrides nameservers (e.g. Cloudflare `1.1.1.1` or Google `8.8.8.8`). Sets `ignore-auto-dns yes`.
- **Manual (Static IP):** For managed networks requiring fixed IPs. Specify IP Address with CIDR prefix (e.g., `192.168.1.50/24`), Gateway, and primary/secondary DNS servers.
- **IPv6:** Configurable as Auto, Custom DNS, Manual, or Disabled.

### 3. Organization HTTP/HTTPS Proxy

For organization districts that mandate content-filtering web proxies:

- Toggle **Enable HTTP/HTTPS Proxy**.
- Specify **Proxy Host** (e.g., `proxy.organization.internal` or IP), **Port** (default `8080`), and comma-separated **Bypass List** (`localhost, 127.0.0.1, *.organization.internal`).
- Proxy parameters are automatically injected into the environment (`http_proxy`, `https_proxy`) and applied to Chromium managed policies (`ProxyMode: "fixed_servers"`).

### 4. Verification & Testing

Click **Apply & Test Network**. The agent applies the NetworkManager configuration, issues a DNS resolution lookup, probes connectivity to `1.1.1.1:53` / `8.8.8.8:53`, and reports live routing status. Click **Proceed to Next Step**.

---

## Step 3 — Choose Destination Mode: Install to Disk vs. Live Preview

Once connected to the network, choose your desired operational mode:

| Mode | Use when |
| :--- | :--- |
| **Install to Hard Disk** *(recommended)* | Permanent deployment to thin client SSD/HDD. Partitions the drive with `LABKIOSK_DATA` so network profiles and enrollment tokens persist. |
| **Live Preview & Temporary Enrollment** | Evaluation, temporary lab assessments, or machines where writing to internal storage is prohibited. |

---

## Step 4 — Install to the internal drive

In the wizard, select the **Install to Hard Disk** tab.

### Choose the target disk

The list shows candidate disks of at least 7 GiB — room for two system images side by side. **The USB stick you booted from is excluded** — the installer matches it through `/proc/mounts` and `/sys` and refuses it both when listing and again immediately before wiping.

Removable drives are still shown and labelled `REMOVABLE DRIVE`, because internal eMMC on some thin clients reports as removable. They sort last, so the default selection is always an internal disk. Read the label before you continue.

### Set a boot-menu & admin password

Use **Generate** for a random 20-character password, or type your own.

**Record it before installing.** It is hashed in the browser with WebCrypto (PBKDF2 SHA-512) and only the digest is sent onward; the plaintext never reaches the agent and is never written to disk. It protects both the GRUB boot menu and post-installation network administration.

### Run installation

Click **Install Lab Kiosk to Drive**. The installer:

1. Partitions the disk as hybrid GPT — `bios_grub`, `ESP`, `ROOT`, `DATA`.
2. Formats filesystems and copies the medium's system image (`vmlinuz`, `initrd.img`, `filesystem.squashfs`) to `images/<version>/` on `ROOT`. The installed drive is an image store: it boots that same squashfs through live-boot, under the same RAM overlay as the USB stick.
3. Copies NetworkManager profiles to `/etc/labkiosk/system-connections` on `LABKIOSK_DATA`; a unit in the image bind-mounts them over `/etc/NetworkManager/system-connections` at every boot.
4. Carries the enrolment, the proxy setting (`proxy.json`) and the language and region (`localization.json`) onto the data partition; the agent re-applies them at every start.
5. Installs GRUB for UEFI `x86_64-efi`, UEFI removable, and legacy BIOS `i386-pc` (skipped on NVMe and eMMC targets), with the boot menu on `ROOT`.
6. Writes this installation's boot password and the data partition's UUID next to the boot menu, and names the image as the one to boot.

Details: [Disk Installer](Disk-Installer).

### Reboot

Click **Reboot System**. On the way down the machine stops with:

```text
Please remove the live-medium, close the tray (if any) and press ENTER to continue:
```

(or, for a USB stick, *"Lab Kiosk: remove the installation USB stick, then press ENTER to continue"*).
Remove the USB stick — or detach the ISO, in a VM — and press ENTER; otherwise the firmware boots the
installer again. systemd caps this wait, so an unattended machine carries on by itself.

The workstation then boots into the installed OS, and the wizard displays `INSTALLED WORKSTATION`. An installed disk never shows the remove-the-medium prompt on later reboots: its boot menu passes `noeject` and `labkiosk.installed=1`.

---

## Step 5 — Enrol the workstation

| Field | Value |
| :--- | :--- |
| **Organization subdomain** | e.g. `oakridge` — or your custom domain, if your organization has one approved |
| **Workstation identifier** | e.g. `PC-01`. Must match `^[A-Z0-9][A-Z0-9_-]{0,62}$` |
| **Enrollment key** | From Settings → Workstation Enrollment Key |

Click **Connect & Register Workstation**.

The agent validates the control plane URL, writes `/etc/labkiosk/config.json` (mode `0600`), syncs the Chromium policy, and restarts the browser once into the locked kiosk session.

Within three seconds the workstation appears on the Admin console with a live thumbnail.

---

## Step 6 — Post-Installation Network Management

On an installed workstation running with `overlayroot="tmpfs"`:

1. **Top-Bar Network Icon:** Hover near the top edge to reveal the auto-hiding kiosk bar. Click the network icon next to the status dot.
2. **Administrator Verification:** An authentication modal will appear inside the closed Shadow DOM. Enter the administrator / boot menu password configured during installation.
3. **Network Configuration Modal:** On successful verification, the kiosk opens `http://127.0.0.1:8888/setup#network` where interfaces, Wi-Fi networks, IP addressing, and proxy settings can be reconfigured. The form shows the settings currently in force, and leaving the Wi-Fi password blank keeps the saved one. After installation this is the **only** route to the network page — the wizard itself opens on enrolment.
4. **Persistence:** Changes are saved directly to `LABKIOSK_DATA` and persist across reboots.
5. **Offline Auto-Fallback:** If the workstation loses network connectivity for >6 consecutive seconds while navigating external pages, it will automatically redirect to `/setup#offline` so staff can reconnect without terminal access, and return to the page on its own once the connection is back.

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

Then, from the admin console:

- Every workstation shows a live thumbnail and an online indicator.
- **Lock all** raises the curtain everywhere.
- A broadcast navigates the whole lab at once.
- **Reset to portal** brings them back.

---

## Remote control

Interactive remote desktop needs no setup: an operator with the `workstations` permission clicks **Remote Control** on a workstation's card, and the session goes through a relay on the console's own address, over the same outbound connection the workstation already holds. Nothing is provisioned per workstation and no inbound port is opened.

→ [Remote Control](Remote-Control)

---

## Re-enrolling or moving a workstation

1. On the admin console, remove it (`/api/clients/remove`). This revokes its device token; its next heartbeat gets `401`.
2. Within one heartbeat the workstation shows the wizard's **Register this workstation again** form, with the top bar still available.
   (A workstation that is still enrolled gets the same form from the network page: **Register with Another Organization…**.)
3. Enter the administrator (boot) password when asked, then the new organization's subdomain and enrollment key.

The same happens by itself if the organization is deleted. Nothing needs clearing by hand: the new enrolment replaces the old one.

Rotating the enrollment key does **not** affect already-enrolled workstations — they hold their own tokens. Rotation only stops *new* enrolments with the old key.

---

## Troubleshooting first installs

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| No candidate drives listed | Disk under 7 GiB, or the only disk is the live medium | Check the disk size; install to a different machine |
| Enrolment rejected | Empty or stale key, or the organization is `pending`/`suspended` | Generate a key; have a super admin approve the organization |
| "This page is blocked" after enrolling | Chromium has not reloaded policy | Wait for the automatic restart; if it persists, check `/tmp/lab-agent.log` |
| "This site isn't allowed on this workstation" (with the top bar) | The site is not on the allowlist, or a broadcast arrived before Chromium reloaded its policy | It retries once by itself after a few seconds; otherwise add the domain to the allowlist |
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

→ [Workstation Simulator](Workstation-Simulator) · [Admin Console Guide](Admin-Console-Guide)
