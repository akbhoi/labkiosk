#!/usr/bin/env python3
"""
Make a Raspberry Pi SD card image of a Lab Kiosk release (wiki/Raspberry-Pi.md).

A Raspberry Pi starts from its own firmware, not UEFI, so it cannot boot the
arm64 ISO. This writes the same release -- the arm64 ISO's kernel, initrd and
system image, untouched -- onto a FAT partition with the Pi's firmware, its
device trees and a kernel command line, as one disk image to flash:

    python3 distro-builder/tools/labkiosk-raspi.py build \
        --iso labkiosk-debian13-arm64.iso --firmware raspi-firmware_<version>_all.deb \
        --out labkiosk-debian13-raspi-arm64.img \
        [--org oakridge --key XXXXX-XXXXX-XXXXX-XXXXX] [--admin-hash grub.pbkdf2...]

The card boots the Pi 4 family (Pi 4 Model B, Pi 400, Compute Module 4) with
Debian's own kernel. The Pi 5 needs a newer kernel than Debian 13's.

The workstation runs as a network-booted one does (labkiosk.netboot=1): from
RAM, keeping nothing, with no disk installer, enrolling itself at every start
with the organization and enrollment key on its command line, under the
hostname its network card gives it. Those can be written here, or later into
cmdline.txt on the card, from any computer. It updates by flashing the card
with a newer release.

Needs xorriso, unsquashfs (squashfs-tools), dpkg-deb, mkfs.vfat (dosfstools)
and mcopy (mtools). Nothing is mounted: it runs without root.
"""

import argparse
import gzip
import importlib.machinery
import importlib.util
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader("labkiosk_netboot", os.path.join(HERE, "labkiosk-netboot.py"))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
netboot = importlib.util.module_from_spec(_spec)
_loader.exec_module(netboot)

LIVE_FILES = ("vmlinuz", "initrd.img", "filesystem.squashfs")
VERSION_FILE = "usr/share/labkiosk/version"
ARCHITECTURE_FILE = "usr/share/labkiosk/architecture"
# The Pi 4 family's device trees, as the kernel names them: with
# upstream_kernel=1 the firmware loads these names from the card's root.
DTB_PATTERN = re.compile(r"^usr/lib/linux-image-[^/]+/broadcom/(bcm2711-rpi-[a-z0-9-]+\.dtb)\Z")
# The Pi 4 family's firmware: the GPU's start and fixup files.
FIRMWARE_PATTERN = re.compile(r"^(start4[a-z]*\.elf|fixup4[a-z]*\.dat)\Z")
REQUIRED_FIRMWARE = ("start4.elf", "fixup4.dat")
# An arm64 Linux Image carries this at offset 0x38 (Documentation/arch/arm64/booting.rst).
ARM64_IMAGE_MAGIC = b"ARM\x64"
SECTOR = 512
# The partition starts 4 MiB in, as Raspberry Pi OS's does; the slack is room for
# cmdline.txt edits and anything an administrator adds beside the image.
PARTITION_START = 4 * 1024 * 1024
SLACK = 64 * 1024 * 1024
VOLUME_LABEL = "LABKIOSK"
CONFIG_TXT = """\
# Lab Kiosk OS for the Raspberry Pi 4, Pi 400 and Compute Module 4.
# The firmware reads this file; the kernel's command line is cmdline.txt.
arm_64bit=1
# Debian's kernel and the device trees it ships, not Raspberry Pi OS's.
upstream_kernel=1
kernel=vmlinux
initramfs initrd.img followkernel
disable_overscan=1
enable_uart=1
"""
README_TXT = """\
Lab Kiosk OS {version} for Raspberry Pi
=======================================

Boots the Raspberry Pi 4 Model B, Pi 400 and Compute Module 4, with 2 GB of
memory or more (4 GB recommended), a screen on HDMI and a keyboard or a touch
screen. The Raspberry Pi 5 is not supported by this release.

The workstation runs from memory and keeps nothing on the card. At every start
it enrols itself with the organization and enrollment key in cmdline.txt, under
a name taken from its network card, so the console shows it in the same place
each time.

Before the first start, open cmdline.txt on this card with a plain text editor
and add, on the same single line, separated by spaces:

    labkiosk.org=<your organization's subdomain>
    labkiosk.key=<your enrollment key, from Settings > Workstation Enrollment Key>

Optionally:

    labkiosk.admin=<grub-mkpasswd-pbkdf2 digest>   locks the network and
                                                     registration settings
    timezone=<Region/City>                           instead of Asia/Kolkata

To update, flash the card with a newer release.
"""


class BuildError(Exception):
    pass


def run(cmd, **kwargs):
    """Run a command, an argument list never a shell string; its failure is a BuildError."""
    try:
        return subprocess.run(cmd, check=True, capture_output=True, text=True, **kwargs)
    except FileNotFoundError as err:
        raise BuildError(f"{cmd[0]} is not installed") from err
    except subprocess.CalledProcessError as err:
        raise BuildError(f"{' '.join(cmd[:2])} failed: {(err.stderr or err.stdout or '').strip()[-400:]}") from err


def kernel_arguments(args):
    """The command line the card's kernel starts with: a self-enrolling live session."""
    words = ["boot=live", "components", "consoleblank=0", "overlayroot=tmpfs:recurse=0",
             f"timezone={args.timezone}", "username=kiosk", "noeject", "panic=10", "labkiosk.netboot=1",
             "console=tty1"]
    for name, value in (("labkiosk.org", args.org), ("labkiosk.domain", args.domain), ("labkiosk.key", args.key),
                        ("labkiosk.server", args.control_plane), ("labkiosk.admin", args.admin_hash)):
        if value:
            words.append(f"{name}={value}")
    return " ".join(words) + "\n"


def raw_kernel(data):
    """
    The arm64 Image the Pi's firmware can start, from Debian's vmlinuz: as it is,
    gunzipped, or taken out of an EFI zboot wrapper (gzip payload).
    """
    if data[0x38:0x3C] == ARM64_IMAGE_MAGIC:
        return data
    if data[:2] == b"\x1f\x8b":
        image = gzip.decompress(data)
    elif data[:2] == b"MZ" and data[4:8] == b"zimg":
        offset, size = struct.unpack_from("<II", data, 8)
        compression = data[24:56].split(b"\0", 1)[0].decode("ascii", "replace")
        if compression != "gzip":
            raise BuildError(f"the kernel is an EFI zboot image compressed with {compression!r}; only gzip is handled")
        image = gzip.decompress(data[offset:offset + size])
    else:
        raise BuildError("vmlinuz is neither an arm64 Image, a gzip of one, nor an EFI zboot image")
    if image[0x38:0x3C] != ARM64_IMAGE_MAGIC:
        raise BuildError("the decompressed kernel is not an arm64 Image")
    return image


def mbr(total_bytes, start, size, disk_id):
    """A DOS partition table with one bootable FAT32 (LBA) partition."""
    if start % SECTOR or size % SECTOR or start + size > total_bytes:
        raise BuildError("the partition does not fit the image")
    table = bytearray(SECTOR)
    struct.pack_into("<I", table, 440, disk_id)
    entry = struct.pack("<B3sB3sII", 0x80, b"\xfe\xff\xff", 0x0C, b"\xfe\xff\xff", start // SECTOR, size // SECTOR)
    table[446:462] = entry
    table[510:512] = b"\x55\xaa"
    return bytes(table)


def extract_live(iso, work):
    live = os.path.join(work, "live")
    os.makedirs(live)
    cmd = ["xorriso", "-osirrox", "on", "-indev", iso]
    for name in LIVE_FILES:
        cmd += ["-extract", f"/live/{name}", os.path.join(live, name)]
    run(cmd)
    for name in LIVE_FILES:
        if not os.path.isfile(os.path.join(live, name)):
            raise BuildError(f"{iso} has no /live/{name}")
    return live


def read_image(squashfs, work):
    """The release's version, architecture and Pi 4 device trees, from its system image."""
    listing = run(["unsquashfs", "-lc", "-d", "", squashfs]).stdout.splitlines()
    dtbs = sorted(path.lstrip("/") for path in listing if DTB_PATTERN.match(path.lstrip("/")))
    if not dtbs:
        raise BuildError("the system image has no Raspberry Pi 4 device tree (bcm2711-rpi-*.dtb): is it arm64?")
    root = os.path.join(work, "root")
    run(["unsquashfs", "-no-xattrs", "-d", root, squashfs, VERSION_FILE, ARCHITECTURE_FILE, *dtbs])
    with open(os.path.join(root, VERSION_FILE), encoding="utf-8") as handle:
        version = handle.read().strip()
    if not netboot.VERSION_PATTERN.match(version):
        raise BuildError(f"the system image's version {version!r} is not a release version")
    architecture_path = os.path.join(root, ARCHITECTURE_FILE)
    architecture = open(architecture_path, encoding="utf-8").read().strip() if os.path.isfile(architecture_path) else "amd64"
    if architecture != "arm64":
        raise BuildError(f"this is a {architecture} release; a Raspberry Pi needs the arm64 one")
    return version, [os.path.join(root, path) for path in dtbs]


def extract_firmware(deb, work):
    """start4.elf and fixup4.dat (and their variants) from Debian's raspi-firmware package."""
    unpacked = os.path.join(work, "firmware")
    run(["dpkg-deb", "-x", deb, unpacked])
    found = {}
    for folder, _dirs, files in os.walk(unpacked):
        for name in files:
            if FIRMWARE_PATTERN.match(name):
                found.setdefault(name, os.path.join(folder, name))
    missing = [name for name in REQUIRED_FIRMWARE if name not in found]
    if missing:
        raise BuildError(f"{deb} has no {', '.join(missing)}: is it Debian's raspi-firmware package?")
    return [found[name] for name in sorted(found)]


def build(args):
    if os.path.exists(args.out):
        raise BuildError(f"{args.out} exists; choose another name or move it away")
    with tempfile.TemporaryDirectory(prefix="labkiosk-raspi-") as work:
        live = extract_live(args.iso, work)
        version, dtbs = read_image(os.path.join(live, "filesystem.squashfs"), work)
        firmware = extract_firmware(args.firmware, work)

        card = os.path.join(work, "card")
        os.makedirs(os.path.join(card, "live"))
        with open(os.path.join(live, "vmlinuz"), "rb") as handle:
            kernel = raw_kernel(handle.read())
        files = {"vmlinux": kernel, "config.txt": CONFIG_TXT.encode(),
                 "cmdline.txt": kernel_arguments(args).encode(),
                 "README.txt": README_TXT.format(version=version).encode()}
        for name, data in files.items():
            with open(os.path.join(card, name), "wb") as handle:
                handle.write(data)
        shutil.copyfile(os.path.join(live, "initrd.img"), os.path.join(card, "initrd.img"))
        for path in dtbs + firmware:
            shutil.copyfile(path, os.path.join(card, os.path.basename(path)))
        # live-boot finds the system image on any partition it can read, FAT included.
        shutil.move(os.path.join(live, "filesystem.squashfs"), os.path.join(card, "live", "filesystem.squashfs"))

        used = sum(os.path.getsize(os.path.join(folder, name)) for folder, _d, names in os.walk(card) for name in names)
        size = -(-(used + SLACK) // (1024 * 1024)) * 1024 * 1024
        partition = os.path.join(work, "partition.img")
        run(["mkfs.vfat", "-F", "32", "-n", VOLUME_LABEL, "-C", partition, str(size // 1024)])
        entries = [os.path.join(card, name) for name in sorted(os.listdir(card))]
        run(["mcopy", "-i", partition, "-s", "-m", *entries, "::/"])

        disk_id = int.from_bytes(version.encode()[:4].ljust(4, b"\0"), "little")
        total = PARTITION_START + size
        with open(args.out, "wb") as out, open(partition, "rb") as part:
            out.write(mbr(total, PARTITION_START, size, disk_id))
            out.seek(PARTITION_START)
            shutil.copyfileobj(part, out, 16 * 1024 * 1024)
            out.truncate(total)
    print(f"Lab Kiosk OS {version} for Raspberry Pi: {args.out} ({total // (1024 * 1024)} MiB). "
          "Flash it to a card of at least 2 GB.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Make a Raspberry Pi SD card image of a Lab Kiosk release.")
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("build", help="Write a card image from the arm64 release ISO")
    make.add_argument("--iso", required=True, help="The arm64 release ISO (labkiosk-debian13-arm64.iso)")
    make.add_argument("--firmware", required=True, help="Debian's raspi-firmware package (.deb)")
    make.add_argument("--out", required=True, help="The image to write (.img)")
    make.add_argument("--org", help="The organization's subdomain to enrol with")
    make.add_argument("--domain", help="Or the organization's custom domain")
    make.add_argument("--key", help="The organization's enrollment key")
    make.add_argument("--control-plane", help="A control plane other than the platform's, e.g. https://kiosk.example.org")
    make.add_argument("--admin-hash", help="grub-mkpasswd-pbkdf2 digest of the administrator password")
    make.add_argument("--timezone", default="Asia/Kolkata", help="The workstations' time zone (default Asia/Kolkata)")
    args = parser.parse_args(argv)

    args.org = (args.org or "").strip().lower()
    args.domain = (args.domain or "").strip().lower()
    args.key = (args.key or "").strip().upper()
    if args.org and args.domain:
        parser.error("give --org or --domain, not both")
    if args.org and not netboot.ORG_SUBDOMAIN_PATTERN.match(args.org):
        parser.error(f"--org {args.org!r} is not an organization subdomain")
    if args.domain and not netboot.CUSTOM_DOMAIN_PATTERN.match(args.domain):
        parser.error(f"--domain {args.domain!r} is not a domain name")
    if args.key and not netboot.enrollment_key_is_valid(args.key):
        parser.error("--key is not a valid enrollment key (XXXXX-XXXXX-XXXXX-XXXXX, its last character a check)")
    if args.admin_hash and not netboot.GRUB_PBKDF2_PATTERN.match(args.admin_hash):
        parser.error("--admin-hash is not a grub-mkpasswd-pbkdf2 digest (grub.pbkdf2.sha512.<rounds>.<salt>.<hash>)")
    if not netboot.TIMEZONE_PATTERN.match(args.timezone):
        parser.error(f"--timezone {args.timezone!r} is not a time zone name such as Asia/Kolkata")
    if args.control_plane is not None and not re.match(r"^https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?\Z", args.control_plane):
        parser.error("--control-plane must be an http(s):// address with no path")
    try:
        return build(args)
    except (BuildError, OSError, ValueError, EOFError) as err:
        print(f"labkiosk-raspi: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
