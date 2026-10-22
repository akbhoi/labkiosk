## Which file do I need?

| Your machine | Download | Write it to |
| :--- | :--- | :--- |
| A PC, laptop, thin client or virtual machine with an **Intel or AMD** 64-bit processor (almost every Windows PC) | [`labkiosk-debian13-amd64.iso`](https://github.com/akbhoi/labkiosk/releases/download/@VERSION@/labkiosk-debian13-amd64.iso) | A USB stick |
| A 64-bit **ARM** computer or virtual machine that starts through **UEFI** firmware (ARM thin clients and workstations; UTM, Parallels or QEMU on an Apple Silicon Mac) | [`labkiosk-debian13-arm64.iso`](https://github.com/akbhoi/labkiosk/releases/download/@VERSION@/labkiosk-debian13-arm64.iso) | A USB stick |
| A **Raspberry Pi 4 Model B, Pi 400 or Compute Module 4** | [`labkiosk-debian13-raspi-arm64.img.xz`](https://github.com/akbhoi/labkiosk/releases/download/@VERSION@/labkiosk-debian13-raspi-arm64.img.xz) | A microSD card |

Not sure which processor a PC has? On Windows, **Settings → System → About** shows "x64-based processor" for the Intel/AMD ISO and "ARM-based processor" for the ARM one. The **Raspberry Pi 5** and older Pis (3 and earlier) are not supported. Each file has a `.sha256` next to it; the `dpkg-status` files list every package in the images, for auditing.

## System requirements

| | Minimum | Recommended |
| :--- | :--- | :--- |
| Memory | 2 GB | 4 GB |
| Boot medium | USB stick or microSD card of 2 GB | — |
| Disk, to install (PCs and ARM machines only) | 7 GiB (a drive sold as 8 GB) | 12 GB SSD |
| Firmware | Intel/AMD: UEFI (Secure Boot on or off) or legacy BIOS. ARM: UEFI | — |
| Network | Ethernet or a supported Wi-Fi card, with HTTPS to your Lab Kiosk control plane | Ethernet |
| Display and input | A screen and a keyboard, mouse or touch screen | — |

A Raspberry Pi also needs its official 5 V / 3 A USB-C power supply (the Pi 400's own) and a screen on HDMI. Use Ethernet on a Pi: its built-in Wi-Fi is not tested.

## How to install

**On a PC or ARM machine**

1. Write the ISO to a USB stick. This erases the stick.
   - Windows: [Rufus](https://rufus.ie/), and choose **DD Image mode** when it asks.
   - macOS, Linux or Windows: [balenaEtcher](https://etcher.balena.io/).
   - Linux: `sudo dd if=labkiosk-debian13-amd64.iso of=/dev/sdX bs=4M status=progress conv=fsync` (check `/dev/sdX` with `lsblk` first).
2. Boot the machine from the stick (the boot-menu key is usually F12, F11, F9 or Esc).
3. The setup wizard connects to your network and registers the workstation with your organization's enrollment key (console: **Settings → Workstation Enrollment Key**).
4. To keep it, choose **Install to Hard Disk** in the wizard (7 GiB or more). Without that it runs from the stick and keeps nothing at shutdown.

Full steps: [Installation Guide](https://github.com/akbhoi/labkiosk/wiki/Installation-Guide).

**On a Raspberry Pi**

1. Write the `.img.xz` to a microSD card with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) (**Choose OS → Use custom**) or balenaEtcher. Both read the compressed file directly.
2. Put the card back in your computer, open `cmdline.txt` on it with a plain text editor and add, on its single line, `labkiosk.org=<your subdomain> labkiosk.key=<your enrollment key>`.
3. Put the card in the Pi and power it on. It enrols itself at every start and runs from memory.

Full steps: [Raspberry Pi](https://github.com/akbhoi/labkiosk/wiki/Raspberry-Pi).

## Verify the download

```bash
sha256sum -c labkiosk-debian13-amd64.iso.sha256        # Linux
shasum -a 256 -c labkiosk-debian13-amd64.iso.sha256    # macOS
```

On Windows, compare the output of `Get-FileHash labkiosk-debian13-amd64.iso` in PowerShell with the `.sha256` file.

## Updating

- **Installed workstations** (Intel/AMD and ARM) get this release over the air, signed: a feature release once an administrator approves it in the console, a security release at the next start. Each gets the build of its own architecture, and goes back to the previous version by itself if the new one fails to start.
- **Workstations running from a USB stick or the network** start this release when the stick is rewritten or the boot server is prepared again.
- **Raspberry Pi**: write the new card image; nothing on the old card needs keeping.
- Moving installed **4.x workstations (Debian 12)** to 5.x: try one workstation before approving the update for all of them.

## More

- [Network boot](https://github.com/akbhoi/labkiosk/wiki/Network-Boot) whole rooms with no USB sticks.
- [Build it for your own platform](https://github.com/akbhoi/labkiosk/wiki/Building-for-Your-Platform), or with your own signing keys.
- Problems: [Troubleshooting](https://github.com/akbhoi/labkiosk/wiki/Troubleshooting) and [issues](https://github.com/akbhoi/labkiosk/issues).

<!-- labkiosk:changes -->
