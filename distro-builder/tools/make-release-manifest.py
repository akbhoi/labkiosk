#!/usr/bin/env python3
"""
Write the manifest.json of an over-the-air release (docs/OTA_UPDATES.md 5.3).

build-iso.yml runs this on the live/ folder extracted from a release ISO, then
signs the result with the release key and uploads both beside the files:

    python3 distro-builder/tools/make-release-manifest.py \
        --live out/live --version 2.6.1 --security-floor 2.6.0 --channel stable \
        --out out/release/manifest.json

The workstation (usr/local/sbin/labkiosk-update) accepts exactly the fields
written here and checks every chunk hash before it writes the chunk to disk.
A `security` release (`--kind security --base-version 2.6.0`) is written only
by security-rebuild.yml (section 7): the same source as its base release,
rebuilt with newer Debian packages, one patch version up on the same line.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time

IMAGE_FILES = ("vmlinuz", "initrd.img", "filesystem.squashfs")
# 8 MiB: small enough to re-fetch cheaply, few enough hashes to keep the
# manifest of a 1 GB image near 10 KB.
CHUNK_SIZE = 8 * 1024 * 1024
# The same pattern as labkiosk-boot-slots and labkiosk-update.
VERSION_PATTERN = re.compile(r"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?\Z")
CHANNELS = ("stable", "beta")
KINDS = ("feature", "security")


def line_of(version):
    """(major, minor) of a release version: (2, 6) for 2.6.1."""
    major, minor, _ = version.split("-", 1)[0].split(".")
    return int(major), int(minor)


def patch_of(version):
    return int(version.split("-", 1)[0].split(".")[2])


def hash_file(path, chunk_size):
    whole = hashlib.sha256()
    chunks = []
    size = 0
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk_size), b""):
            whole.update(block)
            chunks.append(hashlib.sha256(block).hexdigest())
            size += len(block)
    if size == 0:
        raise ValueError(f"{path} is empty")
    return {"size": size, "sha256": whole.hexdigest(), "chunkSize": chunk_size, "chunks": chunks}


def build_manifest(live_dir, version, security_floor, channel, built_at, chunk_size=CHUNK_SIZE,
                   kind="feature", base_version=None):
    for name, value in (("version", version), ("security floor", security_floor)):
        if not VERSION_PATTERN.match(value):
            raise ValueError(f"{name} {value!r} is not a release version")
    if channel not in CHANNELS:
        raise ValueError(f"channel must be one of {', '.join(CHANNELS)}")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    if kind == "feature" and base_version is not None:
        raise ValueError("only a security release names a base version")
    if kind == "security":
        if base_version is None or not VERSION_PATTERN.match(base_version):
            raise ValueError(f"a security release needs the release it rebuilds as its base version, not {base_version!r}")
        if "-" in version or line_of(version) != line_of(base_version) or patch_of(version) <= patch_of(base_version):
            raise ValueError(f"a security release of {base_version} is a later patch on its line, not {version}")
    files = []
    for name in IMAGE_FILES:
        path = os.path.join(live_dir, name)
        if not os.path.isfile(path):
            raise ValueError(f"{path} is missing")
        files.append(dict(name=name, **hash_file(path, chunk_size)))
    return {
        "version": version,
        "channel": channel,
        "kind": kind,
        "baseVersion": base_version,
        "files": files,
        "securityFloor": security_floor,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(built_at)),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--live", required=True, help="folder holding vmlinuz, initrd.img, filesystem.squashfs")
    parser.add_argument("--version", required=True)
    parser.add_argument("--security-floor", required=True)
    parser.add_argument("--channel", required=True, choices=CHANNELS)
    parser.add_argument("--kind", choices=KINDS, default="feature")
    parser.add_argument("--base-version", help="the release a security release rebuilds")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    # SOURCE_DATE_EPOCH when the build sets one, so a rebuild writes the same manifest.
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    try:
        built_at = int(epoch) if epoch else int(time.time())
        manifest = build_manifest(args.live, args.version, args.security_floor, args.channel, built_at,
                                  kind=args.kind, base_version=args.base_version)
    except ValueError as err:
        print(f"make-release-manifest: {err}", file=sys.stderr)
        return 1
    with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=1, sort_keys=True)
        handle.write("\n")
    total = sum(entry["size"] for entry in manifest["files"])
    print(f"make-release-manifest: {args.out}: {manifest['version']}, {total} bytes in "
          f"{sum(len(entry['chunks']) for entry in manifest['files'])} chunks", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
