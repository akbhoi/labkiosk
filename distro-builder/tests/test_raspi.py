#!/usr/bin/env python3
"""
distro-builder/tools/labkiosk-raspi.py: a Raspberry Pi card image of a release
(wiki/Raspberry-Pi.md). The card's contents are read back from the image with
mtools, as the Pi's firmware would find them.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import contextlib
import gzip
import importlib.machinery
import importlib.util
import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL = os.path.join(ROOT, "tools", "labkiosk-raspi.py")
TOOLS = ("xorriso", "mksquashfs", "unsquashfs", "dpkg-deb", "mkfs.vfat", "mcopy", "mtype", "mdir")
KEY = "AAAAA-BBBBB-CCCCC-DDDD"


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


raspi = load("labkiosk_raspi", TOOL)


def valid_key():
    payload = KEY.replace("-", "")
    return f"{payload[:5]}-{payload[5:10]}-{payload[10:15]}-{payload[15:19]}" + \
        raspi.netboot.enrollment_key_check_character(payload[:19])


def arm64_image(size=4096):
    image = bytearray(size)
    image[0x38:0x3C] = raspi.ARM64_IMAGE_MAGIC
    return bytes(image)


class Kernel(unittest.TestCase):
    def test_an_image_gzip_or_zboot_kernel_becomes_an_image(self):
        image = arm64_image()
        self.assertEqual(raspi.raw_kernel(image), image)
        self.assertEqual(raspi.raw_kernel(gzip.compress(image)), image)
        payload = gzip.compress(image)
        header = bytearray(64)
        header[0:2] = b"MZ"
        header[4:8] = b"zimg"
        struct.pack_into("<II", header, 8, 64, len(payload))
        header[24:28] = b"gzip"
        self.assertEqual(raspi.raw_kernel(bytes(header) + payload), image)

    def test_anything_else_is_refused(self):
        for data in (b"\0" * 4096, gzip.compress(b"\0" * 4096)):
            with self.assertRaises(raspi.BuildError):
                raspi.raw_kernel(data)


class Partitioning(unittest.TestCase):
    def test_one_bootable_fat32_partition(self):
        table = raspi.mbr(raspi.PARTITION_START + 64 * 1024 * 1024, raspi.PARTITION_START, 64 * 1024 * 1024, 7)
        self.assertEqual(len(table), 512)
        self.assertEqual(table[510:], b"\x55\xaa")
        status, kind, first, sectors = table[446], table[450], *struct.unpack_from("<II", table, 454)
        self.assertEqual((status, kind), (0x80, 0x0C))
        self.assertEqual((first, sectors), (raspi.PARTITION_START // 512, 64 * 1024 * 1024 // 512))
        self.assertEqual(table[462:510], bytes(48), "no other partition")
        with self.assertRaises(raspi.BuildError):
            raspi.mbr(raspi.PARTITION_START, raspi.PARTITION_START, 512, 7)


@unittest.skipUnless(all(shutil.which(tool) for tool in TOOLS), f"needs {', '.join(TOOLS)}")
class Card(unittest.TestCase):
    """A card built from a fabricated arm64 release and raspi-firmware package."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lk-raspi-")
        self.addCleanup(shutil.rmtree, self.tmp)

    def release(self, architecture="arm64", dtb=True):
        root = os.path.join(self.tmp, "root")
        os.makedirs(os.path.join(root, "usr/share/labkiosk"))
        with open(os.path.join(root, "usr/share/labkiosk/version"), "w") as handle:
            handle.write("5.0.0\n")
        with open(os.path.join(root, "usr/share/labkiosk/architecture"), "w") as handle:
            handle.write(architecture + "\n")
        dtbs = os.path.join(root, "usr/lib/linux-image-6.12.48+deb13-arm64/broadcom")
        os.makedirs(dtbs)
        names = ("bcm2711-rpi-4-b.dtb", "bcm2711-rpi-400.dtb", "bcm2837-rpi-3-b.dtb") if dtb else ("bcm2837-rpi-3-b.dtb",)
        for name in names:
            with open(os.path.join(dtbs, name), "wb") as handle:
                handle.write(name.encode())
        iso_root = os.path.join(self.tmp, "iso")
        os.makedirs(os.path.join(iso_root, "live"))
        subprocess.run(["mksquashfs", root, os.path.join(iso_root, "live/filesystem.squashfs"), "-quiet", "-noappend"],
                       check=True, capture_output=True)
        with open(os.path.join(iso_root, "live/vmlinuz"), "wb") as handle:
            handle.write(gzip.compress(arm64_image()))
        with open(os.path.join(iso_root, "live/initrd.img"), "wb") as handle:
            handle.write(b"initrd")
        iso = os.path.join(self.tmp, "release.iso")
        subprocess.run(["xorriso", "-as", "mkisofs", "-quiet", "-o", iso, iso_root], check=True, capture_output=True)
        return iso

    def firmware(self):
        package = os.path.join(self.tmp, "pkg")
        files = os.path.join(package, "usr/lib/raspi-firmware")
        os.makedirs(files)
        os.makedirs(os.path.join(package, "DEBIAN"))
        for name in ("start4.elf", "fixup4.dat", "start4x.elf", "fixup4x.dat", "start.elf", "bootcode.bin"):
            with open(os.path.join(files, name), "w") as handle:
                handle.write(name)
        with open(os.path.join(package, "DEBIAN/control"), "w") as handle:
            handle.write("Package: raspi-firmware\nVersion: 1:1.20250430-4\nArchitecture: all\n"
                         "Maintainer: test <test@example.org>\nDescription: test\n")
        deb = os.path.join(self.tmp, "raspi-firmware_all.deb")
        subprocess.run(["dpkg-deb", "--root-owner-group", "-b", package, deb], check=True, capture_output=True)
        return deb

    def build(self, iso, *extra):
        out = os.path.join(self.tmp, "card.img")
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            status = raspi.main(["build", "--iso", iso, "--firmware", self.firmware(), "--out", out, *extra])
        return status, out, err.getvalue()

    def read(self, image, name):
        target = f"{image}@@{raspi.PARTITION_START}"
        return subprocess.run(["mtype", "-i", target, f"::/{name}"], check=True, capture_output=True).stdout

    def test_the_card_holds_the_release_firmware_and_a_self_enrolling_command_line(self):
        status, image, err = self.build(self.release(), "--org", "oakridge", "--key", valid_key())
        self.assertEqual(status, 0, err)
        names = subprocess.run(["mdir", "-b", "-i", f"{image}@@{raspi.PARTITION_START}", "::/"],
                               check=True, capture_output=True, text=True).stdout.split()
        names = {name.rstrip("/").rsplit("/", 1)[-1] for name in names}
        for name in ("vmlinux", "initrd.img", "config.txt", "cmdline.txt", "README.txt", "start4.elf", "fixup4.dat",
                     "start4x.elf", "bcm2711-rpi-4-b.dtb", "bcm2711-rpi-400.dtb", "live"):
            self.assertIn(name, names)
        for name in ("start.elf", "bootcode.bin", "bcm2837-rpi-3-b.dtb"):
            self.assertNotIn(name, names, "only the Pi 4 family's files")
        self.assertEqual(self.read(image, "vmlinux"), arm64_image(), "the kernel is decompressed for the firmware")
        self.assertEqual(self.read(image, "initrd.img"), b"initrd")
        cmdline = self.read(image, "cmdline.txt").decode()
        self.assertEqual(cmdline.count("\n"), 1, "the firmware reads one line")
        for word in ("boot=live", "labkiosk.netboot=1", "labkiosk.org=oakridge", f"labkiosk.key={valid_key()}",
                     "overlayroot=tmpfs:recurse=0", "timezone=Asia/Kolkata"):
            self.assertIn(word, cmdline.split())
        config = self.read(image, "config.txt").decode()
        for line in ("arm_64bit=1", "upstream_kernel=1", "kernel=vmlinux", "initramfs initrd.img followkernel"):
            self.assertIn(line, config.splitlines())
        self.assertIn("5.0.0", self.read(image, "README.txt").decode())
        squashfs = subprocess.run(["mdir", "-b", "-i", f"{image}@@{raspi.PARTITION_START}", "::/live"],
                                  check=True, capture_output=True, text=True).stdout
        self.assertIn("filesystem.squashfs", squashfs)
        with open(image, "rb") as handle:
            table = handle.read(512)
        self.assertEqual(struct.unpack_from("<I", table, 454)[0] * 512, raspi.PARTITION_START)
        self.assertEqual(os.path.getsize(image), raspi.PARTITION_START + struct.unpack_from("<I", table, 458)[0] * 512)

    def test_an_amd64_release_or_one_without_pi_device_trees_is_refused(self):
        status, image, err = self.build(self.release(architecture="amd64"))
        self.assertEqual(status, 1)
        self.assertIn("arm64", err)
        self.assertFalse(os.path.exists(image), "nothing is left behind")

    def test_no_pi4_device_tree_is_refused(self):
        status, _image, err = self.build(self.release(dtb=False))
        self.assertEqual(status, 1)
        self.assertIn("bcm2711", err)

    def test_a_wrong_key_is_refused_before_anything_is_built(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            raspi.main(["build", "--iso", "x.iso", "--firmware", "x.deb", "--out", os.path.join(self.tmp, "x.img"),
                        "--key", "AAAAA-BBBBB-CCCCC-DDDDD"])


if __name__ == "__main__":
    unittest.main()
