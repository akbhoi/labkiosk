# Network Boot

Workstations can start Lab Kiosk OS from a boot server on the local network, with no disk at all. Every machine then runs exactly the same release, the one on the server, from RAM; updating the lab means preparing the next release on the server and restarting the workstations.

It is the same image as the ISO and the installed disk: the same RAM overlay, the same Chromium lockdown, the same agent. What differs is where the image comes from and that nothing survives a restart, not even the enrolment, so each workstation enrols again at every start, by itself.

---

## What you need

- A boot server on the workstations' network: any Linux machine with a web server on **port 80**, a TFTP server for PXE, and a DHCP server you can configure (or `dnsmasq` beside the network's own DHCP server, as a proxy).
- Workstations with **at least 4 GB of RAM**: the system image (about 720 MB) is downloaded into RAM before it starts, on top of what the browser uses.
- A wired network. Firmware network boot does not use Wi-Fi.
- On the server: Python 3, `xorriso` and `squashfs-tools`. For legacy BIOS machines also the `ipxe` package.

## Prepare a release on the server

From a checkout of the repository, with a release ISO:

```bash
python3 distro-builder/tools/labkiosk-netboot.py prepare \
    --iso labkiosk-debian13-amd64.iso \
    --out /srv/labkiosk-netboot \
    --server-address 192.168.1.10 \
    --org oakridge --key XXXXX-XXXXX-XXXXX-XXXXX \
    --admin-hash 'grub.pbkdf2.sha512.200000.<salt>.<hash>'
```

| Option | Meaning |
| :--- | :--- |
| `--iso` or `--live-dir` | The release: an ISO, or its `live/` folder |
| `--out` | The folder the web server (and the TFTP server) publishes |
| `--server-address` | The server's IPv4 address as the workstations reach it, on port 80 |
| `--org` or `--domain` | The organization's subdomain, or its approved custom domain |
| `--key` | The organization's enrollment key. Checked here, so a typo fails now and not at every start |
| `--control-plane` | Only for a control plane other than the platform's, such as `https://kiosk.example.org` |
| `--admin-hash` | A `grub-mkpasswd-pbkdf2` digest of the administrator password. It locks the boot menu against editing and gates the workstations' network and registration settings. Strongly recommended |
| `--timezone` | The workstations' time zone, `Asia/Kolkata` unless given |
| `--arch` | The release's architecture: `amd64` (the default) or `arm64`. One folder serves one architecture; prepare an arm64 release, from `labkiosk-debian13-arm64.iso`, into a folder of its own |

It writes:

| Path | What |
| :--- | :--- |
| `labkiosk/shimx64.efi` | Microsoft-signed shim, taken from the release itself (`shimaa64.efi` for arm64) |
| `labkiosk/grubx64.efi` | Debian-signed network GRUB, which shim starts (`grubaa64.efi` for arm64) |
| `labkiosk/grub.cfg` | The boot menu; copied to `debian-installer/amd64/grub/`, where that GRUB looks for it, and `grub/` |
| `labkiosk/boot.ipxe` | The same boot for iPXE (legacy BIOS; amd64 only) |
| `labkiosk/undionly.kpxe` | iPXE for BIOS PXE, when the server has the `ipxe` package (amd64 only) |
| `labkiosk/<version>/` | `vmlinuz`, `initrd.img`, `filesystem.squashfs` |

Running it again with a newer release adds that version's folder and switches the menus to it in one step; workstations pick it up at their next start. Delete an old version's folder once nothing boots it.

## Point the network at it

Serve the folder on port 80 (any web server; `python3 -m http.server 80 --directory /srv/labkiosk-netboot` will do for a test) and over TFTP from the same folder, then tell DHCP where to send each kind of machine:

| Workstation firmware | DHCP answer |
| :--- | :--- |
| UEFI, PXE (client architecture 7 or 9) | Boot file `labkiosk/shimx64.efi`, over TFTP |
| ARM64 UEFI, PXE (client architecture 11) | Boot file `labkiosk/shimaa64.efi`, over TFTP, from the folder prepared with `--arch arm64` |
| Legacy BIOS (client architecture 0) | Boot file `labkiosk/undionly.kpxe` over TFTP; then, when the request comes from iPXE (user class `iPXE`), `http://<server>/labkiosk/boot.ipxe` |

How to express this depends on the DHCP server; its documentation for "PXE" and "iPXE chainloading" covers it. In the firmware of each workstation, enable network boot (PXE) and put it first.

**UEFI HTTP Boot is not supported.** Debian 12's signed GRUB, which Secure Boot requires, has no HTTP client ([Debian bug #1016873](https://bugs.debian.org/1016873)): started over HTTP it stops at its own prompt without reading its menu. Debian 13's has not been tested for it yet. Use PXE on UEFI machines; the system image itself still comes over HTTP.

UEFI workstations boot with **Secure Boot on**: the firmware checks shim, shim checks GRUB, GRUB checks the kernel, exactly as from the disk. Legacy BIOS has no Secure Boot.

## What each workstation does

1. The firmware fetches shim and GRUB over TFTP (or iPXE); GRUB shows **Lab Kiosk OS** for three seconds and starts it with nobody at the keyboard.
2. The kernel and initrd come over TFTP (over HTTP with iPXE); live-boot downloads `filesystem.squashfs` into RAM (`fetch=`) and starts it under the RAM overlay.
3. `labkiosk-hostname` names the machine `labkiosk-` and six hex digits derived from its network card, the same at every start.
4. The agent sees `labkiosk.netboot=1` and enrols with the organization and key from the boot menu, under that name in capitals (`LABKIOSK-3FA92C`). While the control plane is unreachable it tries again every 15 seconds; after a refusal (a wrong or rotated key) every 10 minutes, because failed enrolments are rate-limited per public address and a whole room shares one.
5. The control plane knows the name from the last start and issues it a new device token, so the workstation keeps its place, its group and its history in the admin console. No token is stored anywhere.

The setup wizard on a network-booted workstation shows **NETWORK BOOT** and has no installer. Without `--org` and `--key`, nobody is enrolled automatically and each workstation would have to be registered by hand at every start.

## Security

Know what this trusts before you use it:

- **The boot network.** GRUB's menu, the kernel, the initrd (TFTP, or HTTP with iPXE) and the system image (HTTP) come unencrypted, and Secure Boot checks only shim, GRUB and the kernel. Anyone who can answer DHCP or intercept TFTP or HTTP on that network can start a modified system on the workstations. Keep the boot network to the workstations and the server (its own VLAN, DHCP snooping on the switches).
- **The enrollment key** is in the boot menu, readable by anyone on that network and on each workstation's kernel command line. It can only enrol workstations, and each enrolment shows in the console; rotate it in the console if it leaks, then run `prepare` again.
- **The boot menu.** Without `--admin-hash`, anyone at a UEFI workstation can edit the boot entry and start a root shell. iPXE (legacy BIOS) cannot be locked this way: anyone pressing Ctrl+B while it starts gets its shell.
- **The firmware.** As with any kiosk, set a firmware password and allow only network boot ([Installation Guide](Installation-Guide#step-5--lock-down-the-firmware)).

## Over-the-air updates

A network-booted workstation reports itself as a live session and is never updated over the air; the console says to update it on the boot server. Prepare the new release with `labkiosk-netboot.py prepare` and restart the room.
