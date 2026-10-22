#!/usr/bin/env python3
"""
Make a pre-configured install stick from a Lab Kiosk release ISO
(wiki/Installation-Guide.md, "Set up many machines from one stick").

    python3 distro-builder/tools/labkiosk-iso.py customize \\
        --iso labkiosk-debian13-amd64.iso --out labkiosk-oakridge.iso \\
        --org oakridge --key XXXXX-XXXXX-XXXXX-XXXXX \\
        --wifi-ssid "Oakridge Staff" \\
        --timezone Asia/Kolkata --locale en_IN.UTF-8 --keymap us

writes a copy of the ISO with the organization, Wi-Fi and language in
labkiosk/preset.json. A machine started from it applies the Wi-Fi and language
by itself and opens the setup wizard on Install, with the drive listed: one
press of Install per machine, which is still what erases a drive. After the
install the workstation registers itself at its first start, under its own
hostname.

    python3 distro-builder/tools/labkiosk-iso.py show --iso labkiosk-oakridge.iso

prints what a customized ISO holds, with the key and the Wi-Fi passphrase
masked.

The Wi-Fi passphrase is read from LABKIOSK_WIFI_PASSWORD, or asked for, so it
stays out of the shell's history. The stick holds the enrollment key and the
passphrase in plain text: keep it like a key to the building, and change the
enrollment key in the console (Settings, Workstation Enrollment Key) if one
goes missing.

Nothing else in the ISO changes: xorriso adds the one file and replays the
release's own boot records (BIOS, UEFI, and Secure Boot's signed shim, GRUB and
kernel), and this tool checks the result boots the same way before it keeps it.

Needs xorriso (Linux, or WSL on Windows: sudo apt install xorriso; macOS:
brew install xorriso).
"""

import argparse
import getpass
import importlib.machinery
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader("labkiosk_netboot", os.path.join(HERE, "labkiosk-netboot.py"))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
netboot = importlib.util.module_from_spec(_spec)
_loader.exec_module(netboot)

# Where the agent reads it: /run/live/medium is the ISO (PRESET_FILE in agent.py).
PRESET_PATH = "/labkiosk/preset.json"
PRESET_VERSION = 1
# What a release ISO must hold to be one.
RELEASE_FILES = ("/live/vmlinuz", "/live/initrd.img", "/live/filesystem.squashfs")
WIFI_PASSWORD_ENV = "LABKIOSK_WIFI_PASSWORD"
# The same shapes the agent accepts (validate_preset in agent.py).
SETTING_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@+/-]{0,63}\Z")
SERVER_PATTERN = re.compile(r"^https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?\Z")
WIFI_SECURITY = {"wpa2": "WPA2", "wpa3": "WPA3", "open": "OPEN"}
# Lines of xorriso's boot report that change with where the files land (or
# are made new on every write), rather than with how the image boots.
REPORT_VOLATILE = re.compile(r"GUID|CRC|ISO image size|[Ii]mage size")


class ToolError(Exception):
    pass


def run(cmd, **kwargs):
    try:
        return subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs)
    except FileNotFoundError as err:
        raise ToolError(f"{cmd[0]} is not installed") from err
    except subprocess.CalledProcessError as err:
        detail = (err.stderr or err.stdout or "").strip().splitlines()[-5:]
        raise ToolError(f"{' '.join(cmd[:3])}... failed: " + " / ".join(detail)) from err


def wifi_problem(ssid, password):
    """Why NetworkManager would refuse this network, or None (wifi_settings in agent.py)."""
    if not ssid.strip() or len(ssid.encode("utf-8")) > 32 or any(ord(ch) < 32 for ch in ssid):
        return "the Wi-Fi network name must be 1 to 32 bytes, with no control characters"
    if password:
        is_hex_key = len(password) == 64 and all(ch in "0123456789abcdefABCDEF" for ch in password)
        if not (8 <= len(password) <= 63 or is_hex_key):
            return "a WPA passphrase is 8 to 63 characters long"
    return None


def build_preset(args, wifi_password):
    """The preset document for the validated arguments."""
    doc = {"version": PRESET_VERSION}
    if args.org or args.domain:
        org = {"subdomain": args.org, "customDomain": args.domain, "enrollmentKey": args.key}
        if args.control_plane:
            org["server"] = args.control_plane
        doc["organization"] = org
    if args.wifi_ssid:
        doc["wifi"] = {"ssid": args.wifi_ssid, "password": wifi_password, "hidden": args.wifi_hidden,
                       "security": WIFI_SECURITY[args.wifi_security]}
    localization = {key: value for key, value in (
        ("timezone", args.timezone), ("locale", args.locale),
        ("keymap", args.keymap), ("keymapVariant", args.keymap_variant)) if value}
    if localization:
        doc["localization"] = localization
    if args.admin_hash:
        doc["bootPasswordHash"] = args.admin_hash
    return doc


def masked(doc):
    """doc with the key and the passphrase hidden, for printing."""
    shown = json.loads(json.dumps(doc))
    org = shown.get("organization")
    if isinstance(org, dict) and org.get("enrollmentKey"):
        org["enrollmentKey"] = str(org["enrollmentKey"])[:5] + "-*****-*****-*****"
    wifi = shown.get("wifi")
    if isinstance(wifi, dict) and wifi.get("password"):
        wifi["password"] = "********"
    return shown


def iso_listing(iso):
    """Every path in the ISO, from xorriso's find."""
    out = run(["xorriso", "-indev", iso, "-find", "/", "-type", "f", "-exec", "report_lba", "--"]).stdout
    # Lines: "File data lba: <start> , <blocks> , <filestart> , <bytes> , '<path>'"
    return {match.group(1) for match in re.finditer(r"'(/[^']*)'\s*$", out, re.MULTILINE)}


def boot_report(iso):
    """How the ISO boots, from xorriso, with the numbers that move left out."""
    out = run(["xorriso", "-indev", iso, "-report_el_torito", "plain", "-report_system_area", "plain"]).stdout
    shape = []
    for line in out.splitlines():
        if ":" not in line or REPORT_VOLATILE.search(line.split(":", 1)[0]):
            continue
        label, value = line.split(":", 1)
        # LBAs, sizes and partition starts follow the files; types, platforms,
        # emulation, flags and paths are what decide how it boots.
        shape.append(label.strip() + ":" + re.sub(r"\b[0-9]+\b", "#", value).strip())
    return shape


def read_preset_from(iso, scratch):
    target = os.path.join(scratch, "preset.json")
    run(["xorriso", "-osirrox", "on", "-indev", iso, "-extract", PRESET_PATH, target])
    with open(target, "rb") as handle:
        return handle.read()


def customize(args, wifi_password):
    src = os.path.abspath(args.iso)
    out = os.path.abspath(args.out)
    if not os.path.isfile(src):
        raise ToolError(f"{args.iso} is not a file")
    if os.path.exists(out):
        raise ToolError(f"{args.out} already exists; choose another name or remove it first")
    listing = iso_listing(src)
    missing = [path for path in RELEASE_FILES if path not in listing]
    if missing:
        raise ToolError(f"{args.iso} is not a Lab Kiosk release ISO: it has no {', '.join(missing)}")
    before = boot_report(src)
    if not before:
        raise ToolError(f"{args.iso} has no boot records")

    doc = build_preset(args, wifi_password)
    data = (json.dumps(doc, indent=2) + "\n").encode("utf-8")
    with tempfile.TemporaryDirectory(prefix="labkiosk-iso-") as scratch:
        os.chmod(scratch, 0o700)
        preset_file = os.path.join(scratch, "preset.json")
        with open(os.open(preset_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
            handle.write(data)
        partial = out + ".partial"
        if os.path.exists(partial):
            os.remove(partial)
        try:
            # -boot_image any replay: the release's El Torito images, MBR, GPT
            # and appended partitions, exactly as they were.
            run(["xorriso", "-indev", src, "-outdev", partial, "-boot_image", "any", "replay",
                 "-map", preset_file, PRESET_PATH, "-chmod", "0444", PRESET_PATH, "--"])
            after = boot_report(partial)
            if after != before:
                changed = sorted(set(before) ^ set(after))
                raise ToolError("the copy would not boot like the release (" + "; ".join(changed)[:400] + ")")
            if read_preset_from(partial, scratch) != data:
                raise ToolError("the settings read back from the copy differ from what was written")
            os.replace(partial, out)
        finally:
            if os.path.exists(partial):
                os.remove(partial)
    print(f"Wrote {args.out}: {args.iso} with these settings in {PRESET_PATH.lstrip('/')}:")
    # Built again with a placeholder: the passphrase itself never reaches the output.
    print(json.dumps(masked(build_preset(args, "********" if wifi_password else "")), indent=2))
    print("Write it to a USB stick as you would the release (Rufus in DD Image mode, balenaEtcher or dd).")
    return 0


def show(args):
    if not os.path.isfile(args.iso):
        raise ToolError(f"{args.iso} is not a file")
    if PRESET_PATH not in iso_listing(os.path.abspath(args.iso)):
        print(f"{args.iso} has no settings: it is a release ISO as published.")
        return 0
    with tempfile.TemporaryDirectory(prefix="labkiosk-iso-") as scratch:
        raw = read_preset_from(os.path.abspath(args.iso), scratch)
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as err:
        raise ToolError(f"{PRESET_PATH} is not valid JSON: {err}") from err
    print(json.dumps(masked(doc), indent=2))
    return 0


def check_arguments(parser, args):
    """Normalise and check customize's arguments as the agent will, so a mistake fails here."""
    args.org = (args.org or "").strip().lower()
    args.domain = (args.domain or "").strip().lower()
    args.key = (args.key or "").strip().upper()
    if args.org and args.domain:
        parser.error("give --org or --domain, not both")
    if (args.org or args.domain) and not args.key:
        parser.error("--org and --domain need --key")
    if args.key and not (args.org or args.domain):
        parser.error("--key needs --org or --domain")
    if args.org and not netboot.ORG_SUBDOMAIN_PATTERN.match(args.org):
        parser.error(f"--org {args.org!r} is not an organization subdomain")
    if args.domain and not netboot.CUSTOM_DOMAIN_PATTERN.match(args.domain):
        parser.error(f"--domain {args.domain!r} is not a domain name")
    if args.key and not netboot.enrollment_key_is_valid(args.key):
        parser.error("--key is not a valid enrollment key (XXXXX-XXXXX-XXXXX-XXXXX, its last character a check)")
    if args.control_plane is not None:
        if not (args.org or args.domain):
            parser.error("--control-plane needs --org or --domain")
        if not SERVER_PATTERN.match(args.control_plane):
            parser.error("--control-plane must be an http(s):// address with no path")
    if args.admin_hash and not netboot.GRUB_PBKDF2_PATTERN.match(args.admin_hash):
        parser.error("--admin-hash is not a grub-mkpasswd-pbkdf2 digest (grub.pbkdf2.sha512.<rounds>.<salt>.<hash>)")
    if args.timezone and not netboot.TIMEZONE_PATTERN.match(args.timezone):
        parser.error(f"--timezone {args.timezone!r} is not a time zone name such as Asia/Kolkata")
    for name in ("locale", "keymap", "keymap_variant"):
        value = getattr(args, name)
        if value and not SETTING_PATTERN.match(value):
            parser.error(f"--{name.replace('_', '-')} {value!r} is not a setting name")
    if args.keymap_variant and not args.keymap:
        parser.error("--keymap-variant needs --keymap")
    if (args.wifi_hidden or args.wifi_security != "wpa2") and not args.wifi_ssid:
        parser.error("--wifi-hidden and --wifi-security need --wifi-ssid")
    if args.wifi_ssid is not None:
        problem = wifi_problem(args.wifi_ssid, "")
        if problem:
            parser.error(problem)
    if not (args.org or args.domain or args.wifi_ssid or args.timezone or args.locale or args.keymap
            or args.admin_hash):
        parser.error("nothing to set: give at least --org/--domain, --wifi-ssid, a language setting or --admin-hash")


def wifi_password_for(args):
    """The passphrase from the environment or the terminal; empty for an open network."""
    if not args.wifi_ssid or args.wifi_security == "open":
        if os.environ.get(WIFI_PASSWORD_ENV):
            raise ToolError(f"{WIFI_PASSWORD_ENV} is set, but the Wi-Fi network is open (or none is given)")
        return ""
    password = os.environ.get(WIFI_PASSWORD_ENV)
    if password is None:
        if not sys.stdin.isatty():
            raise ToolError(f"set {WIFI_PASSWORD_ENV} to the Wi-Fi passphrase, or run this in a terminal")
        password = getpass.getpass(f"Passphrase for Wi-Fi {args.wifi_ssid!r}: ")
    if not password:
        raise ToolError("a passphrase is required for this Wi-Fi network (--wifi-security open for one without)")
    problem = wifi_problem(args.wifi_ssid, password)
    if problem:
        raise ToolError(problem)
    return password


def main(argv=None):
    parser = argparse.ArgumentParser(description="Make a pre-configured Lab Kiosk install stick from a release ISO.")
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("customize", help="Write a copy of a release ISO with settings in it")
    make.add_argument("--iso", required=True, help="The release ISO (labkiosk-debian13-amd64.iso or -arm64.iso)")
    make.add_argument("--out", required=True, help="The ISO to write; must not exist yet")
    make.add_argument("--org", help="The organization's subdomain to register with")
    make.add_argument("--domain", help="Or the organization's custom domain")
    make.add_argument("--key", help="The organization's enrollment key (console: Settings, Workstation Enrollment Key)")
    make.add_argument("--control-plane", help="A control plane other than the platform's, e.g. https://kiosk.example.org")
    make.add_argument("--wifi-ssid", help="A Wi-Fi network to join; the passphrase comes from "
                      f"{WIFI_PASSWORD_ENV} or is asked for")
    make.add_argument("--wifi-hidden", action="store_true", help="The Wi-Fi network does not broadcast its name")
    make.add_argument("--wifi-security", choices=sorted(WIFI_SECURITY), default="wpa2",
                      help="wpa2 (default; also WPA2/WPA3 mixed), wpa3 (WPA3 only) or open")
    make.add_argument("--timezone", help="Time zone, e.g. Asia/Kolkata")
    make.add_argument("--locale", help="System locale, e.g. en_IN.UTF-8")
    make.add_argument("--keymap", help="Keyboard layout, e.g. us or de")
    make.add_argument("--keymap-variant", help="Keyboard layout variant, e.g. nodeadkeys")
    make.add_argument("--admin-hash", help="grub-mkpasswd-pbkdf2 digest of the administrator (boot menu) "
                      "password, set on every machine installed from the stick")
    look = commands.add_parser("show", help="Print the settings in a customized ISO, key and passphrase masked")
    look.add_argument("--iso", required=True)
    args = parser.parse_args(argv)

    try:
        if args.command == "show":
            return show(args)
        check_arguments(parser, args)
        return customize(args, wifi_password_for(args))
    except (ToolError, OSError) as err:
        print(f"labkiosk-iso: {err}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("labkiosk-iso: cancelled; nothing was written", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
