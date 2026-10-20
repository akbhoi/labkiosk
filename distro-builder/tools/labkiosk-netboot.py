#!/usr/bin/env python3
"""
Lay out a Lab Kiosk release for network boot (wiki/Network-Boot.md).

Run on the boot server, from a release ISO (or its live/ folder), into the
folder a web server publishes on port 80 -- and a TFTP server too, for PXE:

    python3 distro-builder/tools/labkiosk-netboot.py prepare \
        --iso labkiosk-debian12-amd64.iso --out /srv/labkiosk-netboot \
        --server-address 192.168.1.10 --org oakridge --key XXXXX-XXXXX-XXXXX-XXXXX \
        --admin-hash grub.pbkdf2.sha512.200000.<salt>.<hash>

It writes:

    labkiosk/shimx64.efi            Microsoft-signed shim (UEFI, Secure Boot on)
    labkiosk/grubx64.efi            Debian-signed network GRUB, which shim starts
    labkiosk/grub.cfg               the menu; also at debian-installer/amd64/grub/
                                    and grub/, where that GRUB may look for it
    labkiosk/boot.ipxe              the same boot for iPXE (legacy BIOS)
    labkiosk/undionly.kpxe          iPXE for BIOS PXE, when the server has it
    labkiosk/<version>/             vmlinuz, initrd.img, filesystem.squashfs

Every workstation boots the same image from RAM and keeps nothing. It enrols
at every boot with the organization and enrollment key named here, under the
hostname labkiosk-hostname derives from its network card, so the control plane
re-issues the same workstation's token each time.

shim and GRUB come out of the release's own squashfs (the shim-signed and
grub-efi-amd64-signed packages): they are the ones that release was tested
with, and Secure Boot checks the kernel against them.

Needs xorriso (for --iso) and unsquashfs (squashfs-tools).
"""

import argparse
import ipaddress
import os
import re
import shutil
import subprocess
import sys
import tempfile

IMAGE_FILES = ("vmlinuz", "initrd.img", "filesystem.squashfs")
# The same pattern as labkiosk-boot-slots and labkiosk-update.
VERSION_PATTERN = re.compile(r"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?\Z")
VERSION_FILE = "usr/share/labkiosk/version"
SHIM = "usr/lib/shim/shimx64.efi.signed"
NETWORK_GRUB = "usr/lib/grub/x86_64-efi-signed/grubnetx64.efi.signed"
# Where Debian's signed network GRUB may look for its menu: beside itself, under
# its built-in prefix, and under the prefix other builds use.
MENU_PATHS = ("labkiosk/grub.cfg", "debian-installer/amd64/grub/grub.cfg", "grub/grub.cfg")
UNDIONLY_CANDIDATES = ("/usr/lib/ipxe/undionly.kpxe", "/usr/share/ipxe/undionly.kpxe")
HOSTNAME_PATTERN = re.compile(r"^(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\Z")
# The same patterns the agent checks the command line with (agent.py).
ORG_SUBDOMAIN_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
CUSTOM_DOMAIN_PATTERN = re.compile(r"^(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
GRUB_PBKDF2_PATTERN = re.compile(r"^grub\.pbkdf2\.sha512\.[0-9]+\.[0-9A-Fa-f]+\.[0-9A-Fa-f]+\Z")
TIMEZONE_PATTERN = re.compile(r"^[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+){0,2}\Z")
# Kept in step with ENROLLMENT_KEY_ALPHABET and enrollment_key_check_character
# in agent.py, so a mistyped key fails here rather than at every boot.
ENROLLMENT_KEY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
ENROLLMENT_KEY_PATTERN = re.compile(r"^[%s]{5}(?:-[%s]{5}){3}\Z" % (ENROLLMENT_KEY_ALPHABET, ENROLLMENT_KEY_ALPHABET))
MAX_SYMLINK_HOPS = 8


def enrollment_key_check_character(payload):
    n = len(ENROLLMENT_KEY_ALPHABET)
    factor = 2
    total = 0
    for char in reversed(payload):
        addend = factor * ENROLLMENT_KEY_ALPHABET.index(char)
        total += addend // n + addend % n
        factor = 1 if factor == 2 else 2
    return ENROLLMENT_KEY_ALPHABET[(n - total % n) % n]


def enrollment_key_is_valid(key):
    if not ENROLLMENT_KEY_PATTERN.match(key):
        return False
    chars = key.replace("-", "")
    return enrollment_key_check_character(chars[:-1]) == chars[-1]


def server_address(value):
    """An IPv4 address or a host name, reached on port 80."""
    value = value.strip().lower()
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        if not HOSTNAME_PATTERN.match(value):
            raise argparse.ArgumentTypeError(f"{value!r} is neither an IP address nor a host name")
        return value
    if address.version != 4:
        raise argparse.ArgumentTypeError("use the boot server's IPv4 address: GRUB and iPXE fetch over IPv4")
    return value


def kernel_arguments(args, version):
    """The command line every network-booted workstation starts with."""
    base = f"http://{args.server_address}/labkiosk/{version}"
    words = [
        "boot=live", "components", f"fetch={base}/filesystem.squashfs",
        "consoleblank=0", "overlayroot=tmpfs:recurse=0", f"timezone={args.timezone}", "username=kiosk",
        "noeject", "panic=10", "labkiosk.netboot=1",
    ]
    if args.org:
        words.append(f"labkiosk.org={args.org}")
    if args.domain:
        words.append(f"labkiosk.domain={args.domain}")
    if args.key:
        words.append(f"labkiosk.key={args.key}")
    if args.control_plane:
        words.append(f"labkiosk.server={args.control_plane}")
    if args.admin_hash:
        words.append(f"labkiosk.admin={args.admin_hash}")
    return " ".join(words)


def grub_menu(args, version):
    host = args.server_address
    lines = [
        "# Lab Kiosk OS -- network boot menu, written by labkiosk-netboot.py prepare.",
        "# The image and its kernel come over HTTP from this boot server.",
        "",
    ]
    if args.admin_hash:
        # The entry still boots unattended (--unrestricted); the password guards
        # only editing it, which would otherwise hand anyone at the keyboard a
        # root shell (init=/bin/sh) or an unlocked administrator gate.
        lines += ['set superusers="labkiosk"', f"password_pbkdf2 labkiosk {args.admin_hash}", ""]
    lines += [
        "insmod http",
        "set timeout=3",
        "set default=0",
        "",
        f'menuentry "Lab Kiosk OS {version} (network)" --unrestricted --id labkiosk {{',
        f"    linux (http,{host})/labkiosk/{version}/vmlinuz {kernel_arguments(args, version)}",
        f"    initrd (http,{host})/labkiosk/{version}/initrd.img",
        "}",
        "",
    ]
    return "\n".join(lines)


def ipxe_script(args, version):
    base = f"http://{args.server_address}/labkiosk/{version}"
    return "\n".join([
        "#!ipxe",
        "# Lab Kiosk OS -- network boot for iPXE, written by labkiosk-netboot.py prepare.",
        f"kernel {base}/vmlinuz initrd=initrd.img {kernel_arguments(args, version)}",
        f"initrd {base}/initrd.img",
        "boot",
        "",
    ])


def run(cmd):
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except FileNotFoundError as err:
        raise SystemExit(f"labkiosk-netboot: {cmd[0]} is not installed ({err})") from err
    if proc.returncode != 0:
        raise SystemExit(f"labkiosk-netboot: {' '.join(cmd)} failed ({proc.returncode}): {proc.stderr.strip()}")
    return proc.stdout


def extract_live_dir(iso, scratch):
    live = os.path.join(scratch, "live")
    run(["xorriso", "-osirrox", "on", "-indev", iso, "-extract", "/live", live])
    return live


def extract_from_squashfs(squashfs, path, scratch):
    """
    One file out of the image, following symbolic links inside the image (shim
    is reached through update-alternatives). Returns the extracted regular file.
    """
    for _ in range(MAX_SYMLINK_HOPS):
        target_dir = tempfile.mkdtemp(dir=scratch)
        os.rmdir(target_dir)
        run(["unsquashfs", "-no-progress", "-d", target_dir, squashfs, path])
        extracted = os.path.join(target_dir, path)
        if os.path.islink(extracted):
            link = os.readlink(extracted)
            path = os.path.normpath(link.lstrip("/") if os.path.isabs(link) else os.path.join(os.path.dirname(path), link))
            if path.startswith(".."):
                raise SystemExit(f"labkiosk-netboot: {link} points outside the image")
            continue
        if not os.path.isfile(extracted):
            raise SystemExit(f"labkiosk-netboot: /{path} is not in the image")
        return extracted
    raise SystemExit(f"labkiosk-netboot: too many symbolic links resolving /{path}")


def write_file(path, content, mode=0o644):
    """Replace path in one step, so a client never fetches half of it."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f"{path}.tmp-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def copy_file(source, destination):
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    temporary = f"{destination}.tmp-{os.getpid()}"
    shutil.copyfile(source, temporary)
    os.chmod(temporary, 0o644)
    os.replace(temporary, destination)


def prepare(args):
    if bool(args.org) == bool(args.domain) and (args.org or args.domain):
        raise SystemExit("labkiosk-netboot: name the organization by --org or by --domain, not both")
    if bool(args.org or args.domain) != bool(args.key):
        raise SystemExit("labkiosk-netboot: --key and --org (or --domain) go together")
    if not args.admin_hash:
        print("labkiosk-netboot: WARNING: no --admin-hash. Anyone at a workstation's keyboard can edit its boot "
              "entry, and its network and registration settings stay unlocked.", file=sys.stderr)
    if args.key:
        print("labkiosk-netboot: NOTE: the enrollment key is served over plain HTTP in the boot menu; anyone on "
              "this network can read it. Keep the boot network to the workstations, and rotate the key in the "
              "console if it leaks.", file=sys.stderr)

    with tempfile.TemporaryDirectory(prefix="labkiosk-netboot.") as scratch:
        live = args.live_dir or extract_live_dir(args.iso, scratch)
        for name in IMAGE_FILES:
            if not os.path.isfile(os.path.join(live, name)):
                raise SystemExit(f"labkiosk-netboot: {name} is missing from {live}")
        squashfs = os.path.join(live, "filesystem.squashfs")
        with open(extract_from_squashfs(squashfs, VERSION_FILE, scratch), encoding="utf-8") as handle:
            version = handle.read().strip()
        if not VERSION_PATTERN.match(version):
            raise SystemExit(f"labkiosk-netboot: the image's version {version!r} is not a release version")

        out = os.path.abspath(args.out)
        for name in IMAGE_FILES:
            copy_file(os.path.join(live, name), os.path.join(out, "labkiosk", version, name))
        copy_file(extract_from_squashfs(squashfs, SHIM, scratch), os.path.join(out, "labkiosk", "shimx64.efi"))
        copy_file(extract_from_squashfs(squashfs, NETWORK_GRUB, scratch), os.path.join(out, "labkiosk", "grubx64.efi"))

    undionly = next((path for path in UNDIONLY_CANDIDATES if os.path.isfile(path)), None)
    if undionly:
        copy_file(undionly, os.path.join(out, "labkiosk", "undionly.kpxe"))
    menu = grub_menu(args, version)
    for relative in MENU_PATHS:
        write_file(os.path.join(out, relative), menu)
    write_file(os.path.join(out, "labkiosk", "boot.ipxe"), ipxe_script(args, version))

    host = args.server_address
    print(f"Lab Kiosk OS {version} is ready for network boot in {out}.")
    print(f"  UEFI HTTP Boot:  http://{host}/labkiosk/shimx64.efi")
    print("  UEFI PXE:        labkiosk/shimx64.efi over TFTP from the same folder")
    if undionly:
        print("  BIOS PXE:        labkiosk/undionly.kpxe over TFTP, then "
              f"http://{host}/labkiosk/boot.ipxe")
    else:
        print(f"  BIOS (iPXE):     http://{host}/labkiosk/boot.ipxe "
              "(install the ipxe package and run this again to add undionly.kpxe for BIOS PXE)")
    print("Serve the folder on port 80; wiki/Network-Boot.md has the DHCP settings.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Lay out a Lab Kiosk release for network boot.")
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare", help="Copy a release into a web root and write its boot menus")
    source = prep.add_mutually_exclusive_group(required=True)
    source.add_argument("--iso", help="A Lab Kiosk release ISO")
    source.add_argument("--live-dir", help="The live/ folder of a release (vmlinuz, initrd.img, filesystem.squashfs)")
    prep.add_argument("--out", required=True, help="The folder the web server publishes on port 80")
    prep.add_argument("--server-address", required=True, type=server_address,
                      help="This boot server's IPv4 address (or name) as the workstations reach it")
    prep.add_argument("--org", help="The organization's subdomain to enrol with")
    prep.add_argument("--domain", help="Or the organization's custom domain")
    prep.add_argument("--key", help="The organization's enrollment key")
    prep.add_argument("--control-plane", help="A control plane other than the platform's, e.g. https://kiosk.example.org")
    prep.add_argument("--admin-hash", help="grub-mkpasswd-pbkdf2 digest of the administrator password")
    prep.add_argument("--timezone", default="Asia/Kolkata", help="The workstations' time zone (default Asia/Kolkata)")
    args = parser.parse_args(argv)

    args.org = (args.org or "").strip().lower()
    args.domain = (args.domain or "").strip().lower()
    args.key = (args.key or "").strip().upper()
    if args.org and not ORG_SUBDOMAIN_PATTERN.match(args.org):
        parser.error(f"--org {args.org!r} is not an organization subdomain")
    if args.domain and not CUSTOM_DOMAIN_PATTERN.match(args.domain):
        parser.error(f"--domain {args.domain!r} is not a domain name")
    if args.key and not enrollment_key_is_valid(args.key):
        parser.error("--key is not a valid enrollment key (XXXXX-XXXXX-XXXXX-XXXXX, its last character a check)")
    if args.admin_hash and not GRUB_PBKDF2_PATTERN.match(args.admin_hash):
        parser.error("--admin-hash is not a grub-mkpasswd-pbkdf2 digest (grub.pbkdf2.sha512.<rounds>.<salt>.<hash>)")
    if not TIMEZONE_PATTERN.match(args.timezone):
        parser.error(f"--timezone {args.timezone!r} is not a time zone name such as Asia/Kolkata")
    if args.control_plane is not None and not re.match(r"^https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?\Z", args.control_plane):
        parser.error("--control-plane is an origin such as https://kiosk.example.org, with no path")
    return prepare(args)


if __name__ == "__main__":
    sys.exit(main())
