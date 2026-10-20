#!/usr/bin/env python3
"""
Install the image this chroot was unpacked from onto a loop device, with the
real installer (usr/local/bin/labkiosk-install).

boot-test.sh runs this inside the ISO's own root filesystem, with the ISO's
live/ directory at /run/live/medium/live, so partitioning, the image copy,
grub-install and grubenv are exactly what a workstation's live session does.
Two things differ, and only these:

- the target is a loop device, which TARGET_DISK_PATTERN rightly refuses on a
  workstation;
- `swapoff -a` is skipped: in a chroot it would act on the host's swap;
- whether the data partition is encrypted is decided by --encrypt-data, not
  by whether the host running the test happens to have a TPM. The VM that
  boots an encrypted disk gets a software TPM (boot-test.sh, scenario 10);
- with --dual-boot (scenario 11), the install goes beside the disk's other
  system as if this session had started in UEFI mode, and efibootmgr is
  played here rather than run: the real one would write the host's firmware
  boot entries. The stand-in checks the entry the installer asks for, and
  boot-test.sh gives the VM that same entry.
"""
import importlib.machinery
import importlib.util
import re
import sys

# The shared disk boot-test.sh makes has its EFI system partition first.
EXPECTED_ESP_NUMBER = "1"

INSTALLER = "/usr/local/bin/labkiosk-install"
LOOP_DEVICE_PATTERN = re.compile(r"^/dev/loop[0-9]+\Z")


def load_installer():
    loader = importlib.machinery.SourceFileLoader("labkiosk_install", INSTALLER)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class FirmwareEntries:
    """efibootmgr as the installer drives it, over a firmware with one other system's entry."""

    def __init__(self, disk, loader, label):
        self.disk = disk
        self.loader = loader
        self.label = label
        self.entries = {"0001": "other system"}
        self.order = ["0001"]

    def listing(self):
        lines = ["BootCurrent: 0001", "BootOrder: " + ",".join(self.order)]
        lines += [f"Boot{number}* {label}\tHD(1,GPT)" for number, label in sorted(self.entries.items())]
        return "\n".join(lines)

    def run(self, cmd):
        print(f"[boot-test] efibootmgr stand-in: {' '.join(cmd[1:])}", file=sys.stderr)
        if cmd == ["efibootmgr"]:
            return self.listing()
        if cmd[1:2] == ["--bootnum"] and cmd[3:] == ["--delete-bootnum"]:
            self.entries.pop(cmd[2], None)
            self.order = [n for n in self.order if n != cmd[2]]
            return self.listing()
        expected = ["efibootmgr", "--create", "--disk", self.disk, "--part", EXPECTED_ESP_NUMBER,
                    "--label", self.label, "--loader", self.loader]
        if cmd != expected:
            raise RuntimeError(f"unexpected efibootmgr call {cmd}, expected {expected}")
        number = f"{max(int(n, 16) for n in self.entries) + 1:04X}"
        self.entries[number] = self.label
        self.order.insert(0, number)
        return self.listing()


def main(argv):
    flags = argv[2:]
    if len(argv) < 2 or not LOOP_DEVICE_PATTERN.match(argv[1]) or \
            any(flag not in ("--encrypt-data", "--dual-boot") for flag in flags) or len(set(flags)) != len(flags):
        print("usage: install_into_disk.py /dev/loopN [--encrypt-data] [--dual-boot]", file=sys.stderr)
        return 2
    encrypt = "--encrypt-data" in flags
    dual_boot = "--dual-boot" in flags
    installer = load_installer()
    installer.TARGET_DISK_PATTERN = LOOP_DEVICE_PATTERN
    installer.tpm2_available = lambda: encrypt
    real_run_cmd = installer.run_cmd
    firmware = FirmwareEntries(argv[1], installer.BOOT_ENTRY_LOADER, installer.BOOT_ENTRY_LABEL)
    if dual_boot:
        installer.booted_with_uefi = lambda: True

    def run_cmd(cmd, check=True):
        if cmd[:1] == ["swapoff"]:
            print("[boot-test] skipped swapoff: it would act on the host", file=sys.stderr)
            return ""
        if cmd[:1] == ["efibootmgr"]:
            if not dual_boot:
                raise RuntimeError("an install onto a whole disk must not touch the firmware's boot entries")
            return firmware.run(cmd)
        return real_run_cmd(cmd, check)

    installer.run_cmd = run_cmd
    installer.install_to_disk(argv[1], dual_boot=dual_boot)
    if dual_boot and firmware.entries.get(firmware.order[0]) != firmware.label:
        raise RuntimeError("the installer did not leave Lab Kiosk first in the boot order")
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main(sys.argv))
