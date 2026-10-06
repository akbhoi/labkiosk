#!/usr/bin/env python3
"""
Run the image's own labkiosk-update against a virtual disk's image store.

boot-test.sh has no shell inside the VM (an installed kiosk has none), so it
mounts the disk's LABKIOSK_ROOT on the host and calls labkiosk-update's
download and install functions on it, with the ISO's own copy of the program.
On a workstation `labkiosk-update download URL` does exactly this, with three
things that only a running workstation has; here they are arguments:

- the image store is /run/live/medium, remounted read-write around the call;
- the running version comes from the kernel command line;
- the keys and the security floor are the running image's files.

Usage:
  update_on_disk.py PROGRAM download ROOT URL RUNNING FLOOR KEYRING_DIR
  update_on_disk.py PROGRAM install  ROOT VERSION RUNNING FLOOR KEYRING_DIR

Prints the result as JSON. Exits 1 when labkiosk-update refuses, 2 on misuse.
"""

import importlib.machinery
import importlib.util
import json
import sys


def load(path):
    loader = importlib.machinery.SourceFileLoader("labkiosk_update", path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def main(argv):
    if len(argv) != 8 or argv[2] not in ("download", "install"):
        print(__doc__.strip().split("Usage:")[1], file=sys.stderr)
        return 2
    program, command, root, target, running, floor, keyring_dir = argv[1:]
    update = load(program)
    try:
        if command == "download":
            result = update.download(root, target, running, floor, keyring_dir)
        else:
            result = update.install(root, target, running, floor, keyring_dir)
    except (OSError, RuntimeError, ValueError) as err:
        print(json.dumps({"error": str(err)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main(sys.argv))
