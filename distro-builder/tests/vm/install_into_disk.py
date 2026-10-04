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
- `swapoff -a` is skipped: in a chroot it would act on the host's swap.
"""
import importlib.machinery
import importlib.util
import re
import sys

INSTALLER = "/usr/local/bin/labkiosk-install"
LOOP_DEVICE_PATTERN = re.compile(r"^/dev/loop[0-9]+\Z")


def load_installer():
    loader = importlib.machinery.SourceFileLoader("labkiosk_install", INSTALLER)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def main(argv):
    if len(argv) != 2 or not LOOP_DEVICE_PATTERN.match(argv[1]):
        print("usage: install_into_disk.py /dev/loopN", file=sys.stderr)
        return 2
    installer = load_installer()
    installer.TARGET_DISK_PATTERN = LOOP_DEVICE_PATTERN
    real_run_cmd = installer.run_cmd

    def run_cmd(cmd, check=True):
        if cmd[:1] == ["swapoff"]:
            print("[boot-test] skipped swapoff: it would act on the host", file=sys.stderr)
            return ""
        return real_run_cmd(cmd, check)

    installer.run_cmd = run_cmd
    installer.install_to_disk(argv[1])
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main(sys.argv))
