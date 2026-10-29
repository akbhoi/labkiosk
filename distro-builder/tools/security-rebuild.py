#!/usr/bin/env python3
"""
The steps of the daily security rebuild (docs/OTA_UPDATES.md section 7).

security-rebuild.yml runs this from the default branch; everything that
decides something is here, so it is tested (distro-builder/tests/
test_security_rebuild.py) instead of living in shell.

    lines     from the repository's tags, the release lines to look after --
              with --policy (the controller's GET /api/release-support), every
              line that can update over the air, whose major release is not
              at end of life and that no newer line of its major classified
              stable supersedes; without it, the latest two -- and for each the
              newest tag and the version its rebuild gets (patch + 1, past any
              version already tagged or, with --published, already in R2).
    builds    for each of those lines, one build per architecture its tag's
              source builds, with that source's Debian security suite, ISO
              name and the runner that builds it.
    check     which packages installed in an image (its dpkg status file) have
              a newer version in the Debian security archive. The index is
              read from --index files, or fetched from --mirror for --suite
              and --architecture.
    decide    from the check of every build, the lines to rebuild: a line is
              rebuilt for all its architectures when any of them is outdated.
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
import subprocess
import sys
import time
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
COMPONENTS = ("main", "contrib", "non-free", "non-free-firmware")
ARCHITECTURE_PATTERN = re.compile(r"^[a-z0-9]{2,16}\Z")
SUITE_PATTERN = re.compile(r"^[a-z]{2,16}-security\Z")
# The Debian release behind each codename a source tree can build: its ISO is
# labkiosk-debian<number>-<architecture>.iso.
DEBIAN_RELEASES = {"bookworm": 12, "trixie": 13}
# The GitHub runner that builds each architecture natively: live-build under
# emulation takes hours.
RUNNERS = {"amd64": "ubuntu-latest", "arm64": "ubuntu-24.04-arm"}
# amd64 first: it is the folder's root in R2 and its manifest goes up last.
DEFAULT_ARCHITECTURE = "amd64"
HTTP_TIMEOUT = 120
# deb.debian.org is a CDN; a dropped connection or a 5xx is retried, a 4xx is not.
FETCH_ATTEMPTS = 4
FETCH_BACKOFF_SECONDS = 10
MAX_INDEX_BYTES = 256 * 1024 * 1024

# What a source tree builds, relative to the repository root. A tree without
# config/arch/ predates arm64 and builds amd64 alone.
AUTO_CONFIG = "distro-builder/auto/config"
ARCH_FOLDER = "distro-builder/config/arch"
ARCH_FILES = ("packages.list.chroot", "bootloaders")
DISTRIBUTION_PATTERN = re.compile(r"^\s*--distribution\s+\"?([a-z]+)\"?\s*\\?\s*$", re.MULTILINE)

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


SUPPORT_STATUSES = ("supported", "security_only", "end_of_life")
MAX_MAJOR = 9999


def end_of_life_majors(policy_text):
    """
    The major releases at end of life, from the controller's answer to
    GET /api/release-support: {"majors": [{"major": 2, "status": ...}]}.
    Anything else is an error, never an empty set: a policy that cannot be read
    must not rebuild a major the platform ended.
    """
    try:
        policy = json.loads(policy_text)
    except json.JSONDecodeError as err:
        raise ValueError(f"the release support policy is not JSON: {err}") from err
    entries = policy.get("majors") if isinstance(policy, dict) else None
    if not isinstance(entries, list):
        raise ValueError("the release support policy has no list of majors")
    ended = set()
    for entry in entries:
        major = entry.get("major") if isinstance(entry, dict) else None
        status = entry.get("status") if isinstance(entry, dict) else None
        # bool is an int to Python; true is not a major release.
        if (not isinstance(major, int) or isinstance(major, bool) or not 0 <= major <= MAX_MAJOR
                or status not in SUPPORT_STATUSES):
            raise ValueError(f"the release support policy has an entry that is not a major and a status: {entry!r}")
        if status == "end_of_life":
            ended.add(major)
    return ended


def stable_releases(policy_text):
    """
    The feature releases a super admin classified stable, from the
    controller's answer to GET /api/release-support: {"stable": ["3.1.0"]}.
    Anything else is an error, never an empty list: a policy that cannot be
    read must not decide which lines are superseded.
    """
    try:
        policy = json.loads(policy_text)
    except json.JSONDecodeError as err:
        raise ValueError(f"the release support policy is not JSON: {err}") from err
    entries = policy.get("stable") if isinstance(policy, dict) else None
    if not isinstance(entries, list):
        raise ValueError("the release support policy has no list of stable releases")
    stable = set()
    for entry in entries:
        version = stable_version("v" + entry) if isinstance(entry, str) else None
        if version is None:
            raise ValueError(f"the release support policy lists a stable release that is not a version: {entry!r}")
        stable.add(version)
    return stable


def superseded_lines(lines, stable):
    """
    The lines older than the newest line of their major with a release
    classified stable: once 3.1 is stable, 3.0 gets no more security rebuilds.
    """
    newest_stable = {}
    for major, minor, _patch in stable:
        newest_stable[major] = max(newest_stable.get(major, minor), minor)
    return {line for line in lines if line[0] in newest_stable and line[1] < newest_stable[line[0]]}


def published_versions(text):
    """
    The versions already in the R2 releases bucket, from a listing with one
    folder name per line (such as `2.10.1` or `releases/2.10.1/`). Anything
    else on a line is an error: a listing that cannot be read must not let a
    rebuild take a version that is already published.
    """
    versions = set()
    for raw in text.splitlines():
        name = raw.strip()
        if not name:
            continue
        if name.startswith("releases/"):
            name = name[len("releases/"):]
        name = name.rstrip("/")
        if not VERSION_PATTERN.match(name):
            raise ValueError(f"the list of published releases has a line that is not a version: {raw!r}")
        versions.add(name)
    return versions


def next_free_version(major, minor, patch, taken):
    """The first version of the line above `patch` that no tag and no published release has."""
    for candidate in range(patch + 1, 10000):
        version = f"{major}.{minor}.{candidate}"
        if version not in taken:
            return version
    raise ValueError(f"the line {major}.{minor} has no free patch version left")


def plan_lines(tags, only_line=None, kept=LINES_KEPT, first=FIRST_OTA_VERSION, end_of_life=None, published=(),
               stable=None):
    """
    The release lines to rebuild, newest first, among the stable tags from
    `first` on, each with its newest tag and the version its rebuild gets.
    With `end_of_life` (the major releases the platform ended), every line of
    every other major; without it, the `kept` highest lines. With `stable` (the
    (major, minor, patch) of each release classified stable), a line older than
    the newest stable line of its major is left out: its workstations move to
    that line, which gets the fixes. A pre-release tag is never a base:
    it is not offered to a stable organization, and its fixes arrive with the
    release it leads to.

    The rebuild's version is the base's patch + 1, skipping every version that
    is already a tag or already `published` in R2 without one (a run that
    uploaded its release and then could not push its tag): the controller
    keeps the first manifest it sees for a version, so a version is never
    built twice.
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
    if end_of_life is None:
        chosen = sorted(newest, reverse=True)[:kept]
    else:
        chosen = sorted((line for line in newest if line[0] not in end_of_life), reverse=True)
    superseded = superseded_lines(newest, stable) if stable is not None else set()
    chosen = [line for line in chosen if line not in superseded]
    if only_line is not None:
        if not LINE_PATTERN.match(only_line):
            raise ValueError(f"{only_line!r} is not a release line such as 2.9")
        wanted = tuple(int(part) for part in only_line.split("."))
        if end_of_life is not None and wanted[0] in end_of_life:
            raise ValueError(f"{only_line} belongs to Lab Kiosk {wanted[0]}, which has reached end of life: "
                             "it receives no security rebuilds")
        if wanted in superseded:
            newer = max(minor for major, minor, _patch in stable if major == wanted[0])
            raise ValueError(f"{only_line} is superseded by {wanted[0]}.{newer}, the newest stable line of Lab Kiosk "
                             f"{wanted[0]}: it receives no security rebuilds")
        if wanted not in chosen:
            raise ValueError(f"{only_line} is not one of the lines kept up to date: "
                             f"{', '.join('.'.join(map(str, line)) for line in chosen) or 'none'}")
        chosen = [wanted]
    taken = set(published)
    for tag in tags:
        if VERSION_PATTERN.match(tag[1:] if tag[:1] in ("v", "V") else ""):
            taken.add(tag[1:])
    plan = []
    for line in chosen:
        (major, minor, patch), tag = newest[line]
        plan.append({
            "line": f"{major}.{minor}",
            "tag": tag,
            "base": f"{major}.{minor}.{patch}",
            "version": next_free_version(major, minor, patch, taken),
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


def fetch(url, sleep=time.sleep):
    """One index, retried with a growing pause when the mirror drops the connection or answers 5xx."""
    request = urllib.request.Request(url, headers={"User-Agent": "LabKioskSecurityRebuild/1"})
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
                return response.read(MAX_INDEX_BYTES + 1)
        except urllib.error.HTTPError as err:
            if err.code < 500 or attempt == FETCH_ATTEMPTS:
                raise RuntimeError(f"could not fetch {url}: {err}") from err
            failure = err
        except (urllib.error.URLError, OSError) as err:
            if attempt == FETCH_ATTEMPTS:
                raise RuntimeError(f"could not fetch {url} after {attempt} attempts: {err}") from err
            failure = err
        log(f"fetching {url} failed ({failure}); attempt {attempt + 1} of {FETCH_ATTEMPTS} in {FETCH_BACKOFF_SECONDS * attempt}s")
        sleep(FETCH_BACKOFF_SECONDS * attempt)
    raise AssertionError("unreachable")


def fetch_indices(mirror, suite, architecture, components=COMPONENTS):
    """The Packages index of each component, from the security archive's mirror."""
    if not mirror.startswith("https://"):
        raise ValueError(f"the mirror {mirror!r} must be an https:// address")
    if not SUITE_PATTERN.match(suite or ""):
        raise ValueError(f"{suite!r} is not a Debian security suite such as trixie-security")
    if not ARCHITECTURE_PATTERN.match(architecture or ""):
        raise ValueError(f"{architecture!r} is not a Debian architecture")
    texts = []
    for component in components:
        url = f"{mirror.rstrip('/')}/dists/{suite}/{component}/binary-{architecture}/Packages.xz"
        data = fetch(url)
        if len(data) > MAX_INDEX_BYTES:
            raise RuntimeError(f"{url} is larger than {MAX_INDEX_BYTES} bytes")
        try:
            texts.append(lzma.decompress(data).decode("utf-8"))
        except (lzma.LZMAError, UnicodeDecodeError) as err:
            raise RuntimeError(f"{url} is not an xz-compressed index: {err}") from err
        log(f"read {url}")
    return texts


# --------------------------------------------------------------------------
# What each line's source builds, and which lines are rebuilt
# --------------------------------------------------------------------------

def source_platforms(auto_config, arch_paths):
    """
    The Debian release and the architectures a source tree builds, from its
    distro-builder/auto/config and the files under distro-builder/config/arch/
    (paths relative to that folder, such as `arm64/bootloaders`). An
    architecture counts only with both of its files, as auto/config requires.
    """
    found = DISTRIBUTION_PATTERN.findall(auto_config)
    if len(set(found)) != 1:
        raise ValueError(f"{AUTO_CONFIG} names no single Debian distribution: {found or 'none'}")
    codename = found[0]
    if codename not in DEBIAN_RELEASES:
        raise ValueError(f"{AUTO_CONFIG} builds Debian {codename}, which this tool does not know: "
                         f"add it to DEBIAN_RELEASES")
    files = {}
    for path in arch_paths:
        arch, _sep, name = path.strip().strip("/").partition("/")
        files.setdefault(arch, set()).add(name)
    architectures = sorted((arch for arch, names in files.items() if set(ARCH_FILES) <= names),
                           key=lambda arch: (arch != DEFAULT_ARCHITECTURE, arch))
    if not files:
        architectures = [DEFAULT_ARCHITECTURE]
    if not architectures:
        raise ValueError(f"{ARCH_FOLDER} defines no architecture with both {' and '.join(ARCH_FILES)}")
    for arch in architectures:
        if not ARCHITECTURE_PATTERN.match(arch):
            raise ValueError(f"{ARCH_FOLDER}/{arch} is not a Debian architecture")
        if arch not in RUNNERS:
            raise ValueError(f"no runner builds {arch}: add it to RUNNERS")
    number = DEBIAN_RELEASES[codename]
    return {
        "suite": f"{codename}-security",
        "architectures": [{"arch": arch, "iso": f"labkiosk-debian{number}-{arch}.iso", "runner": RUNNERS[arch]}
                          for arch in architectures],
    }


def git_platforms(repo, tag):
    """source_platforms() of a tag of the repository at `repo`, read with git."""
    def git(*args):
        result = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)}: {result.stderr.strip()}")
        return result.stdout
    auto_config = git("show", f"{tag}:{AUTO_CONFIG}")
    listing = git("ls-tree", "-r", "--name-only", tag, "--", ARCH_FOLDER + "/")
    paths = [line[len(ARCH_FOLDER) + 1:] for line in listing.splitlines() if line.startswith(ARCH_FOLDER + "/")]
    return source_platforms(auto_config, paths)


def plan_builds(lines, platforms, epoch):
    """
    One build per line and architecture. `platforms` maps each line's tag to
    source_platforms(); `epoch` is the time every build of this run commits
    its version bump at, so the builds of one line, on different runners,
    make the very same commit, and the one tag names all of them.
    """
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch <= 0:
        raise ValueError(f"{epoch!r} is not a time in seconds")
    builds = []
    for line in lines:
        source = platforms[line["tag"]]
        for target in source["architectures"]:
            builds.append({**line, "epoch": epoch, "suite": source["suite"], **target})
    return builds


def decide(builds, decisions, force=False):
    """
    The builds to run and the lines to publish. `decisions` is the check of
    each build: {"version", "arch", "outdated": a count}. A line is rebuilt,
    for every one of its architectures, when any of them is outdated (or with
    `force`): the release is one version, the same on every architecture. A
    line missing the check of one of its architectures is not rebuilt; its
    check failed, and failed the run.
    """
    checked = {}
    for entry in decisions:
        count = entry.get("outdated") if isinstance(entry, dict) else None
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError(f"a check that is not a version, an architecture and a count: {entry!r}")
        checked[(entry.get("version"), entry.get("arch"))] = count
    by_version = {}
    for build in builds:
        by_version.setdefault(build["version"], []).append(build)
    chosen, lines = [], []
    for version, targets in by_version.items():
        counts = [checked.get((version, target["arch"])) for target in targets]
        if None in counts:
            missing = [t["arch"] for t, count in zip(targets, counts) if count is None]
            log(f"{targets[0]['tag']}: no check for {', '.join(missing)}; the line is not rebuilt")
            continue
        if not force and not any(counts):
            continue
        chosen += targets
        first = targets[0]
        lines.append({key: first[key] for key in ("line", "tag", "base", "version", "newest", "epoch", "suite")}
                     | {"architectures": [target["arch"] for target in targets]})
    return {"builds": chosen, "lines": lines}


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


def notes(base_tag, version, base_statuses, new_statuses):
    """
    Markdown release notes: the packages whose version changed, from the base
    image's and the rebuilt image's dpkg status of each architecture, in the
    same order. A package that changed alike on several architectures is
    listed once.
    """
    if len(base_statuses) != len(new_statuses) or not base_statuses:
        raise ValueError("the notes need one base and one rebuilt package list per architecture")
    changed = []
    for base_status, new_status in zip(base_statuses, new_statuses):
        before = installed_packages(base_status)
        after = installed_packages(new_status)
        for key in sorted(set(before) | set(after)):
            old = before.get(key, ("", ""))[0]
            new = after.get(key, ("", ""))[0]
            row = (key[0], old or "(not installed)", new or "(removed)")
            if old != new and row not in changed:
                changed.append(row)
    changed.sort()
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
    lines_parser.add_argument("--policy", help="the controller's GET /api/release-support answer, as a file: "
                              "rebuild every line whose major is not at end of life and that no newer "
                              "stable line of its major supersedes")
    lines_parser.add_argument("--published", help="the folders of the R2 releases bucket, one per line, as a file: "
                              "a rebuild never takes a version already published there")
    lines_parser.add_argument("tags", nargs="*")
    builds_parser = sub.add_parser("builds", help="one build per line and architecture its tag's source builds")
    builds_parser.add_argument("--lines", required=True, help="the output of `lines`, as a file")
    builds_parser.add_argument("--repo", default=".", help="the repository holding the lines' tags")
    builds_parser.add_argument("--epoch", required=True, type=int,
                               help="the time, in seconds, every build of this run commits its version at")
    check_parser = sub.add_parser("check", help="installed packages with a newer version in the security archive")
    check_parser.add_argument("--status", required=True, help="the image's var/lib/dpkg/status")
    source = check_parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--index", action="append", help="a Packages or Packages.xz file (repeatable)")
    source.add_argument("--mirror", help=f"fetch the indices from here, such as {DEFAULT_MIRROR}")
    check_parser.add_argument("--suite", help="with --mirror: the security suite, such as trixie-security")
    check_parser.add_argument("--architecture", help="with --mirror: the image's architecture, such as arm64")
    check_parser.add_argument("--fail-if-outdated", action="store_true",
                              help="exit 2 when anything is outdated (a rebuilt image must be current)")
    bump_parser = sub.add_parser("bump", help="write a new version into a source tree")
    bump_parser.add_argument("--root", required=True)
    bump_parser.add_argument("--from", dest="base", required=True)
    bump_parser.add_argument("--to", dest="version", required=True)
    notes_parser = sub.add_parser("notes", help="release notes of a rebuild, as Markdown")
    notes_parser.add_argument("--base-tag", required=True)
    notes_parser.add_argument("--version", required=True)
    notes_parser.add_argument("--base-status", required=True, action="append",
                              help="the base image's dpkg status (repeatable: one per architecture)")
    notes_parser.add_argument("--new-status", required=True, action="append",
                              help="the rebuilt image's, in the same order")
    decide_parser = sub.add_parser("decide", help="the builds to run and the lines to publish, from every check")
    decide_parser.add_argument("--builds", required=True, help="the output of `builds`, as a file")
    decide_parser.add_argument("--decisions", required=True,
                               help="a folder of the checks' answers, one JSON file per build")
    decide_parser.add_argument("--force", action="store_true", help="rebuild every line that was checked")
    args = parser.parse_args(argv)

    try:
        if args.command == "lines":
            ended = None
            stable = None
            if args.policy:
                with open(args.policy, "r", encoding="utf-8") as handle:
                    policy_text = handle.read()
                ended = end_of_life_majors(policy_text)
                stable = stable_releases(policy_text)
            published = set()
            if args.published:
                with open(args.published, "r", encoding="utf-8") as handle:
                    published = published_versions(handle.read())
            print(json.dumps(plan_lines(args.tags, args.line, end_of_life=ended, published=published,
                                        stable=stable)))
        elif args.command == "builds":
            with open(args.lines, "r", encoding="utf-8") as handle:
                lines = json.load(handle)
            platforms = {line["tag"]: git_platforms(args.repo, line["tag"]) for line in lines}
            print(json.dumps(plan_builds(lines, platforms, args.epoch)))
        elif args.command == "decide":
            with open(args.builds, "r", encoding="utf-8") as handle:
                builds = json.load(handle)
            decisions = []
            for name in sorted(os.listdir(args.decisions)):
                if name.endswith(".json"):
                    with open(os.path.join(args.decisions, name), "r", encoding="utf-8") as handle:
                        decisions.append(json.load(handle))
            print(json.dumps(decide(builds, decisions, force=args.force)))
        elif args.command == "check":
            with open(args.status, "r", encoding="utf-8") as handle:
                installed = installed_packages(handle.read())
            if args.mirror:
                texts = fetch_indices(args.mirror, args.suite, args.architecture)
            else:
                texts = [read_index(path) for path in args.index]
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
            statuses = []
            for paths in (args.base_status, args.new_status):
                texts = []
                for path in paths:
                    with open(path, "r", encoding="utf-8") as handle:
                        texts.append(handle.read())
                statuses.append(texts)
            sys.stdout.write(notes(args.base_tag, args.version, *statuses))
    except (OSError, ValueError, RuntimeError, lzma.LZMAError, json.JSONDecodeError, KeyError) as err:
        log(f"ERROR: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
