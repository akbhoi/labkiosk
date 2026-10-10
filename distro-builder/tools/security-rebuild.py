#!/usr/bin/env python3
"""
The steps of the daily security rebuild (docs/OTA_UPDATES.md section 7).

security-rebuild.yml runs this from the default branch; everything that
decides something is here, so it is tested (distro-builder/tests/
test_security_rebuild.py) instead of living in shell.

    lines     from the repository's tags, the release lines to look after --
              the latest two that can update over the air -- and for each the
              newest tag and the version its rebuild gets (patch + 1).
    check     which packages installed in an image (its dpkg status file) have
              a newer version in the Debian security archive. The index is
              read from --index files, or fetched from --mirror.
    bump      write a new version into the four files of a source tree that
              carry it.
    notes     the GitHub release notes of a rebuild: what changed between the
              base image's packages and the rebuilt one's.

The archive's index is only a trigger: the rebuild itself installs packages
with apt, which checks the archive's signatures. Output: JSON on stdout unless
the command says otherwise, messages on stderr.
"""

import argparse
import json
import lzma
import os
import re
import sys
import urllib.error
import urllib.request

# The same pattern as labkiosk-boot-slots, labkiosk-update and make-release-manifest.
VERSION_PATTERN = re.compile(r"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?\Z")
STABLE_PATTERN = re.compile(r"^([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})\Z")
LINE_PATTERN = re.compile(r"^[0-9]{1,4}\.[0-9]{1,4}\Z")
# The first release whose image carries the updater and the release keys: an
# older line cannot take a rebuild over the air, so none is made for it.
FIRST_OTA_VERSION = "2.9.0"
LINES_KEPT = 2

DEFAULT_MIRROR = "https://deb.debian.org/debian-security"
SUITE = "bookworm-security"
COMPONENTS = ("main", "contrib", "non-free", "non-free-firmware")
ARCHITECTURE = "amd64"
HTTP_TIMEOUT = 120
MAX_INDEX_BYTES = 256 * 1024 * 1024

# Where a version lives in the source tree, relative to the repository root.
VERSION_FILE = "distro-builder/config/includes.chroot/usr/share/labkiosk/version"
AGENT_FILE = "distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py"
EXTENSION_MANIFEST = "distro-builder/config/includes.chroot/opt/labkiosk/extension/manifest.json"
WORKER_PACKAGE = "cloudflare-control/package.json"
AGENT_VERSION_PATTERN = re.compile(r'^AGENT_VERSION = "([^"\n]*)"$', re.MULTILINE)
JSON_VERSION_PATTERN = re.compile(r'^(  "version": ")([^"\n]*)(",)$', re.MULTILINE)


def log(message):
    print(f"[security-rebuild] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Release lines
# --------------------------------------------------------------------------

def stable_version(tag):
    """(major, minor, patch) of a stable release tag such as v2.9.1; None for anything else."""
    match = STABLE_PATTERN.match(tag[1:] if tag[:1] in ("v", "V") else "")
    return tuple(int(part) for part in match.groups()) if match else None


def plan_lines(tags, only_line=None, kept=LINES_KEPT, first=FIRST_OTA_VERSION):
    """
    The release lines to rebuild, newest first: the `kept` highest lines among
    the stable tags from `first` on, each with its newest tag and the version
    its rebuild gets. A pre-release tag is never a base: it is not offered to
    a stable organization, and its fixes arrive with the release it leads to.
    """
    floor = stable_version("v" + first)
    newest = {}
    for tag in tags:
        version = stable_version(tag)
        if version is None or version < floor:
            continue
        line = version[:2]
        if line not in newest or version > newest[line][0]:
            newest[line] = (version, tag)
    chosen = sorted(newest, reverse=True)[:kept]
    if only_line is not None:
        if not LINE_PATTERN.match(only_line):
            raise ValueError(f"{only_line!r} is not a release line such as 2.9")
        wanted = tuple(int(part) for part in only_line.split("."))
        if wanted not in chosen:
            raise ValueError(f"{only_line} is not one of the lines kept up to date: "
                             f"{', '.join('.'.join(map(str, line)) for line in chosen) or 'none'}")
        chosen = [wanted]
    plan = []
    for line in chosen:
        (major, minor, patch), tag = newest[line]
        plan.append({
            "line": f"{major}.{minor}",
            "tag": tag,
            "base": f"{major}.{minor}.{patch}",
            "version": f"{major}.{minor}.{patch + 1}",
            "newest": line == max(newest),
        })
    return plan


# --------------------------------------------------------------------------
# Debian versions (deb-version(7)), as dpkg --compare-versions orders them
# --------------------------------------------------------------------------

DEBIAN_VERSION_PATTERN = re.compile(r"^(?:([0-9]+):)?([0-9][A-Za-z0-9.+~:-]*?)(?:-([A-Za-z0-9.+~]+))?\Z")


def split_debian_version(version):
    match = DEBIAN_VERSION_PATTERN.match(version or "")
    if not match:
        raise ValueError(f"{version!r} is not a Debian version")
    epoch, upstream, revision = match.groups()
    return int(epoch or 0), upstream, revision or "0"


def _order(char):
    """The weight dpkg gives one character of a non-digit run: ~ first, then the end, letters, the rest."""
    if char == "~":
        return -1
    if char.isalpha():
        return ord(char)
    return ord(char) + 256


def _compare_part(a, b):
    while a or b:
        prefix_a = re.match(r"[^0-9]*", a).group()
        prefix_b = re.match(r"[^0-9]*", b).group()
        a, b = a[len(prefix_a):], b[len(prefix_b):]
        for i in range(max(len(prefix_a), len(prefix_b))):
            weight_a = _order(prefix_a[i]) if i < len(prefix_a) else 0
            weight_b = _order(prefix_b[i]) if i < len(prefix_b) else 0
            if weight_a != weight_b:
                return -1 if weight_a < weight_b else 1
        digits_a = re.match(r"[0-9]*", a).group()
        digits_b = re.match(r"[0-9]*", b).group()
        a, b = a[len(digits_a):], b[len(digits_b):]
        number_a, number_b = int(digits_a or 0), int(digits_b or 0)
        if number_a != number_b:
            return -1 if number_a < number_b else 1
    return 0


def compare_debian_versions(a, b):
    """-1, 0 or 1, as `dpkg --compare-versions a lt|eq|gt b` would answer."""
    epoch_a, upstream_a, revision_a = split_debian_version(a)
    epoch_b, upstream_b, revision_b = split_debian_version(b)
    if epoch_a != epoch_b:
        return -1 if epoch_a < epoch_b else 1
    return _compare_part(upstream_a, upstream_b) or _compare_part(revision_a, revision_b)


# --------------------------------------------------------------------------
# dpkg status and archive indices: RFC 822-style stanzas
# --------------------------------------------------------------------------

def stanzas(text):
    """Each stanza as a dict of its single-line fields; continuation lines are skipped."""
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        fields = {}
        for line in block.split("\n"):
            if not line or line[0] in " \t":
                continue
            name, sep, value = line.partition(":")
            if sep:
                fields[name.strip()] = value.strip()
        if fields.get("Package"):
            yield fields


def installed_packages(status_text):
    """{(package, architecture): (version, source)} of what dpkg has installed."""
    installed = {}
    for fields in stanzas(status_text):
        if fields.get("Status", "").split()[-1:] != ["installed"]:
            continue
        version = fields.get("Version", "")
        split_debian_version(version)
        source = (fields.get("Source") or fields["Package"]).split()[0]
        installed[(fields["Package"], fields.get("Architecture", ""))] = (version, source)
    if not installed:
        raise ValueError("the dpkg status lists no installed package")
    return installed


def newest_in_index(index_texts):
    """{(package, architecture): version}, the newest of each in the given Packages indices."""
    newest = {}
    for text in index_texts:
        for fields in stanzas(text):
            key = (fields["Package"], fields.get("Architecture", ""))
            version = fields.get("Version", "")
            split_debian_version(version)
            if key not in newest or compare_debian_versions(version, newest[key]) > 0:
                newest[key] = version
    return newest


def outdated(installed, newest):
    """Installed packages the archive has a newer version of, sorted by name."""
    found = []
    for (package, architecture), (version, source) in sorted(installed.items()):
        available = newest.get((package, architecture))
        if available and compare_debian_versions(available, version) > 0:
            found.append({"package": package, "architecture": architecture, "installed": version,
                          "available": available, "source": source})
    return found


def read_index(path):
    with open(path, "rb") as handle:
        data = handle.read(MAX_INDEX_BYTES + 1)
    if len(data) > MAX_INDEX_BYTES:
        raise ValueError(f"{path} is larger than {MAX_INDEX_BYTES} bytes")
    if path.endswith(".xz"):
        data = lzma.decompress(data)
    return data.decode("utf-8")


def fetch_indices(mirror, suite=SUITE, components=COMPONENTS, architecture=ARCHITECTURE):
    """The Packages index of each component, from the security archive's mirror."""
    if not mirror.startswith("https://"):
        raise ValueError(f"the mirror {mirror!r} must be an https:// address")
    texts = []
    for component in components:
        url = f"{mirror.rstrip('/')}/dists/{suite}/{component}/binary-{architecture}/Packages.xz"
        request = urllib.request.Request(url, headers={"User-Agent": "LabKioskSecurityRebuild/1"})
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
                data = response.read(MAX_INDEX_BYTES + 1)
        except (urllib.error.URLError, OSError) as err:
            raise RuntimeError(f"could not fetch {url}: {err}") from err
        if len(data) > MAX_INDEX_BYTES:
            raise RuntimeError(f"{url} is larger than {MAX_INDEX_BYTES} bytes")
        try:
            texts.append(lzma.decompress(data).decode("utf-8"))
        except (lzma.LZMAError, UnicodeDecodeError) as err:
            raise RuntimeError(f"{url} is not an xz-compressed index: {err}") from err
        log(f"read {url}")
    return texts


# --------------------------------------------------------------------------
# The rebuilt source tree
# --------------------------------------------------------------------------

def _replace_one(path, pattern, replacement):
    with open(path, "r", encoding="utf-8", newline="") as handle:
        text = handle.read()
    updated, count = pattern.subn(replacement, text)
    if count != 1:
        raise ValueError(f"{path}: expected one version to replace, found {count}")
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(updated)


def read_versions(root):
    """The version each of the four files carries."""
    found = {}
    with open(os.path.join(root, VERSION_FILE), "r", encoding="utf-8") as handle:
        found[VERSION_FILE] = handle.read().strip()
    with open(os.path.join(root, AGENT_FILE), "r", encoding="utf-8") as handle:
        match = AGENT_VERSION_PATTERN.search(handle.read())
    found[AGENT_FILE] = match.group(1) if match else ""
    for name in (EXTENSION_MANIFEST, WORKER_PACKAGE):
        with open(os.path.join(root, name), "r", encoding="utf-8") as handle:
            found[name] = str(json.load(handle).get("version", ""))
    return found


def bump(root, base, version):
    """Write `version` where the source tree at `root` carries `base`, in all four files."""
    for value in (base, version):
        if not VERSION_PATTERN.match(value):
            raise ValueError(f"{value!r} is not a release version")
    found = read_versions(root)
    wrong = {name: value for name, value in found.items() if value != base}
    if wrong:
        raise ValueError(f"the source does not carry {base} everywhere: {json.dumps(wrong)}")
    with open(os.path.join(root, VERSION_FILE), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(version + "\n")
    _replace_one(os.path.join(root, AGENT_FILE), AGENT_VERSION_PATTERN, f'AGENT_VERSION = "{version}"')
    for name in (EXTENSION_MANIFEST, WORKER_PACKAGE):
        _replace_one(os.path.join(root, name), JSON_VERSION_PATTERN, rf"\g<1>{version}\g<3>")
    if set(read_versions(root).values()) != {version}:
        raise ValueError(f"the source does not carry {version} everywhere after the bump")
    return sorted(found)


def notes(base_tag, version, base_status, new_status):
    """Markdown release notes: the packages whose version changed, by source package."""
    before = installed_packages(base_status)
    after = installed_packages(new_status)
    changed = []
    for key in sorted(set(before) | set(after)):
        old = before.get(key, ("", ""))[0]
        new = after.get(key, ("", ""))[0]
        if old != new:
            changed.append((key[0], old or "(not installed)", new or "(removed)"))
    lines = [
        f"Security rebuild of {base_tag}: the same Lab Kiosk release, rebuilt with the Debian security "
        "updates published since. Workstations on this line install it at their next restart, unless "
        "their organization approves security releases in Settings → Updates.",
        "",
    ]
    if changed:
        lines += ["| Package | Before | After |", "|---|---|---|"]
        lines += [f"| `{name}` | `{old}` | `{new}` |" for name, old, new in changed]
    else:
        lines.append("No package changed version: this rebuild was requested by hand.")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    lines_parser = sub.add_parser("lines", help="the release lines to rebuild, from the repository's tags")
    lines_parser.add_argument("--line", help="only this line, such as 2.9")
    lines_parser.add_argument("tags", nargs="*")
    check_parser = sub.add_parser("check", help="installed packages with a newer version in the security archive")
    check_parser.add_argument("--status", required=True, help="the image's var/lib/dpkg/status")
    source = check_parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--index", action="append", help="a Packages or Packages.xz file (repeatable)")
    source.add_argument("--mirror", help=f"fetch the {SUITE} indices from here, such as {DEFAULT_MIRROR}")
    check_parser.add_argument("--fail-if-outdated", action="store_true",
                              help="exit 2 when anything is outdated (a rebuilt image must be current)")
    bump_parser = sub.add_parser("bump", help="write a new version into a source tree")
    bump_parser.add_argument("--root", required=True)
    bump_parser.add_argument("--from", dest="base", required=True)
    bump_parser.add_argument("--to", dest="version", required=True)
    notes_parser = sub.add_parser("notes", help="release notes of a rebuild, as Markdown")
    notes_parser.add_argument("--base-tag", required=True)
    notes_parser.add_argument("--version", required=True)
    notes_parser.add_argument("--base-status", required=True)
    notes_parser.add_argument("--new-status", required=True)
    args = parser.parse_args(argv)

    try:
        if args.command == "lines":
            print(json.dumps(plan_lines(args.tags, args.line)))
        elif args.command == "check":
            with open(args.status, "r", encoding="utf-8") as handle:
                installed = installed_packages(handle.read())
            texts = fetch_indices(args.mirror) if args.mirror else [read_index(path) for path in args.index]
            found = outdated(installed, newest_in_index(texts))
            for entry in found:
                log(f"{entry['package']} {entry['installed']} -> {entry['available']}")
            log(f"{len(found)} of {len(installed)} installed packages have a security update")
            print(json.dumps({"installed": len(installed), "outdated": found}))
            if found and args.fail_if_outdated:
                return 2
        elif args.command == "bump":
            changed = bump(args.root, args.base, args.version)
            log(f"{args.base} -> {args.version} in {', '.join(changed)}")
            print(json.dumps({"version": args.version, "files": changed}))
        else:
            if not VERSION_PATTERN.match(args.version):
                raise ValueError(f"{args.version!r} is not a release version")
            with open(args.base_status, "r", encoding="utf-8") as handle:
                base_status = handle.read()
            with open(args.new_status, "r", encoding="utf-8") as handle:
                new_status = handle.read()
            sys.stdout.write(notes(args.base_tag, args.version, base_status, new_status))
    except (OSError, ValueError, RuntimeError, lzma.LZMAError) as err:
        log(f"ERROR: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
