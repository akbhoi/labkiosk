#!/usr/bin/env python3
"""
boot-test.sh, scenario 11: compare a shared disk's partition table (sfdisk -J)
before and after Lab Kiosk was installed beside its other system. Every
partition that was there is unchanged; Lab Kiosk added exactly its own EFI system
partition and its image store, data and swap partitions, the swap one with the Linux swap type that
labkiosk-swap checks for.

Usage: check_dual_boot_layout.py BEFORE.json AFTER.json
"""
import json
import sys

LINUX_SWAP = "0657FD6D-A4AB-43C4-84E5-0933C84B4F4F"
EFI_SYSTEM = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
ADDED = ("LABKIOSK_ESP", "LABKIOSK_ROOT", "LABKIOSK_DATA", "LABKIOSK_SWAP")


def partitions(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)["partitiontable"]["partitions"]


def main(argv):
    if len(argv) != 3:
        print("usage: check_dual_boot_layout.py BEFORE.json AFTER.json", file=sys.stderr)
        return 2
    before, after = partitions(argv[1]), partitions(argv[2])
    shape = lambda p: (p["start"], p["size"], p["type"].upper(), p.get("name"))
    now = {p["node"]: shape(p) for p in after}
    problems = [f"{p['node']} changed: {shape(p)} -> {now.get(p['node'])}"
                for p in before if now.get(p["node"]) != shape(p)]
    by_name = {p.get("name"): p for p in after}
    problems += [f"no {name} partition" for name in ADDED if name not in by_name]
    if by_name.get("LABKIOSK_SWAP", {}).get("type", "").upper() != LINUX_SWAP:
        problems.append("LABKIOSK_SWAP is not a Linux swap partition")
    if by_name.get("LABKIOSK_ESP", {}).get("type", "").upper() != EFI_SYSTEM:
        problems.append("LABKIOSK_ESP is not an EFI system partition")
    if len(after) != len(before) + len(ADDED):
        problems.append(f"{len(after) - len(before)} partitions added, expected {len(ADDED)}")
    if problems:
        print("; ".join(problems), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main(sys.argv))
