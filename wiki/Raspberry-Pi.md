# Raspberry Pi

From 5.0, each release has a microSD card image for the **Raspberry Pi 4 family**: `labkiosk-debian13-raspi-arm64.img.xz`. It is the release's `arm64` system, unchanged, with the Pi's own boot files in front of it.

| Board | Supported |
| :--- | :--- |
| Raspberry Pi 4 Model B (2 GB or more) | Yes |
| Raspberry Pi 400 | Yes |
| Compute Module 4 (2 GB or more, on a carrier board with HDMI and Ethernet) | Yes |
| Raspberry Pi 5, Pi 500, Compute Module 5 | No: Debian 13's kernel does not drive its I/O chip (RP1), so there is no Ethernet, USB or display |
| Raspberry Pi 3 and older, Zero | No |

The Pi starts from its own firmware, not UEFI, so it cannot boot the `arm64` ISO; the card image is the way in.

---

## How a Pi workstation runs

A Pi workstation works like a [network-booted](Network-Boot) one:

- It runs from memory. Nothing is written to the card, and nothing survives a restart.
- At every start it **enrols itself** with the organization and enrollment key written in `cmdline.txt`, under a name taken from its network card (`LABKIOSK-3FA92C`), so the console shows it in the same place each time.
- It has **no disk installer** and **no over-the-air updates**. It updates by writing the card with a newer release.

---

## Install

You need a microSD card of 2 GB or more, the Pi's official USB-C power supply (5 V, 3 A), a screen on HDMI, a keyboard, mouse or touch screen, and **Ethernet**. The Pi's built-in Wi-Fi has not been tested with Lab Kiosk.

1. **Download** `labkiosk-debian13-raspi-arm64.img.xz` and its `.sha256` from the [latest release](https://github.com/akbhoi/labkiosk/releases/latest), and check it: `sha256sum -c labkiosk-debian13-raspi-arm64.img.xz.sha256`.
2. **Write it to the card** with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) (**Choose OS → Use custom**, then the `.img.xz`) or [balenaEtcher](https://etcher.balena.io/). Both read the compressed file. In Raspberry Pi Imager, skip the "OS customisation" settings: they are for Raspberry Pi OS and do nothing here.
3. **Set the organization.** Take the card out and put it back in. A drive named `LABKIOSK` appears. Open `cmdline.txt` on it in a plain text editor (Notepad, TextEdit in plain-text mode, nano) and add to its **single line**, separated by spaces:

   ```text
   labkiosk.org=oakridge labkiosk.key=XXXXX-XXXXX-XXXXX-XXXXX
   ```

   `labkiosk.org` is your organization's subdomain (or use `labkiosk.domain=` for its approved custom domain); the key is in the console under **Settings → Workstation Enrollment Key**. Keep it all on one line: the firmware reads only the first.
4. **Start the Pi** with the card in. It shows **NETWORK BOOT** in the setup wizard and appears in the console once it reaches the control plane.

One card can be copied to every Pi in a room: each enrols under its own name.

### Optional settings in `cmdline.txt`

| Setting | Does |
| :--- | :--- |
| `labkiosk.admin=grub.pbkdf2.sha512...` | Locks the network and registration settings behind a password. Make the digest with `grub-mkpasswd-pbkdf2` on any Linux machine. |
| `timezone=Region/City` | Replaces the card's `timezone=Asia/Kolkata`. |
| `labkiosk.server=https://...` | A control plane at another address than the default. |

### Prepare the card on a computer instead

`distro-builder/tools/labkiosk-raspi.py` builds the card image from a release's `arm64` ISO, with the settings already in it, and checks the key's format before writing anything:

```bash
python3 distro-builder/tools/labkiosk-raspi.py build \
  --iso labkiosk-debian13-arm64.iso \
  --firmware raspi-firmware_<version>_all.deb \
  --out labkiosk-oakridge.img \
  --org oakridge --key XXXXX-XXXXX-XXXXX-XXXXX
```

It needs `xorriso`, `squashfs-tools`, `dpkg-deb`, `dosfstools` and `mtools`, runs without root, and mounts nothing. Get the firmware package on Debian 13 with the `non-free-firmware` component enabled: `apt-get download raspi-firmware`. Run `--help` for every option.

---

## Update

Write the card with the newer release's image, and add the same `cmdline.txt` settings again (or build it with `labkiosk-raspi.py` and the same options). The card holds nothing else worth keeping.

---

## What is on the card

One FAT32 partition, readable from any computer:

| File | Is |
| :--- | :--- |
| `start4*.elf`, `fixup4*.dat` | The Pi 4 family's boot firmware, from Debian's `raspi-firmware` package |
| `bcm2711-rpi-*.dtb` | The Pi 4 family's device trees, from the release's own kernel |
| `config.txt` | Tells the firmware to start the 64-bit kernel `vmlinux` with `initrd.img` (`upstream_kernel=1`, since these are Debian's, not Raspberry Pi OS's) |
| `cmdline.txt` | The kernel command line: live boot from RAM, self-enrolment, your settings |
| `vmlinux`, `initrd.img` | The release's `arm64` kernel (unpacked, as the firmware needs it) and initramfs |
| `live/filesystem.squashfs` | The release's `arm64` system image |
| `README.txt` | These steps, short |

CI builds the card from the `arm64` ISO after that ISO's smoke test passes, and attaches it to the release. No Pi is in CI: the card's contents are tested, but not a boot on real hardware.

→ [Installation Guide](Installation-Guide) · [Network Boot](Network-Boot) · [Building for Your Platform](Building-for-Your-Platform)
