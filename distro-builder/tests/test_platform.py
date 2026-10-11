#!/usr/bin/env python3
"""
Power, hostname, the encrypted data partition, Secure Boot and the GPU.

A workstation never sleeps; each one has a hostname of its own; on a machine
with a TPM 2.0 chip its data partition is encrypted and unlocks itself with
nobody at the keyboard (labkiosk-data-unlock); the setup wizard says whether
Secure Boot was on; Chromium decodes video on the GPU. These tests drive the
parts that run without root and pin the image configuration the rest depends
on. The VM boot test (tests/vm/boot-test.sh) boots the real thing under Secure
Boot firmware and a software TPM.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import hashlib
import importlib.machinery
import importlib.util
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROOT = os.path.join(ROOT, "config", "includes.chroot")
UNLOCK_PATH = os.path.join(CHROOT, "usr/local/sbin/labkiosk-data-unlock")
HOSTNAME_PATH = os.path.join(CHROOT, "usr/local/sbin/labkiosk-hostname")

CRYPT_ID = "0f3c2a51-7d4e-4b8a-9c1d-2e5f6a7b8c9d"
DATA_ID = "6c1f3d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f"


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as handle:
        return handle.read()


def package_list():
    return {line.split("#")[0].strip() for line in
            read(ROOT, "config/package-lists/kiosk.list.chroot").splitlines()} - {""}


def kernel_lines():
    cfg = read(CHROOT, "usr/share/labkiosk/boot/grub.cfg")
    lines = [line.split() for line in cfg.splitlines() if line.strip().startswith("linux ")]
    assert lines, "grub.cfg has no linux lines"
    return lines


unlock = load("labkiosk_data_unlock", UNLOCK_PATH)
installer = load("labkiosk_install_platform", os.path.join(CHROOT, "usr/local/bin/labkiosk-install"))
agent = load("labkiosk_agent_platform", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))

unlock.log = lambda message: None


class NeverSleeps(unittest.TestCase):
    """A kiosk powers off or restarts; it never suspends or hibernates."""

    def test_logind_powers_off_and_ignores_sleep_keys_and_the_lid(self):
        conf = read(CHROOT, "etc/systemd/logind.conf.d/labkiosk.conf")
        settings = dict(re.findall(r"(?m)^(\w+)=(\S+)$", conf))
        self.assertEqual(settings.pop("HandlePowerKey"), "poweroff")
        self.assertEqual(settings.pop("HandleRebootKey"), "reboot")
        for key in ("HandleSuspendKey", "HandleHibernateKey", "HandleLidSwitch",
                    "HandleLidSwitchExternalPower", "HandleLidSwitchDocked", "IdleAction"):
            self.assertEqual(settings.get(key), "ignore", key)
        self.assertEqual(set(settings.values()), {"ignore"})

    def test_systemd_sleep_refuses_every_kind(self):
        conf = read(CHROOT, "etc/systemd/sleep.conf.d/labkiosk.conf")
        for key in ("AllowSuspend", "AllowHibernation", "AllowSuspendThenHibernate", "AllowHybridSleep"):
            self.assertRegex(conf, rf"(?m)^{key}=no$")

    def test_the_sleep_targets_are_masked(self):
        hook = read(ROOT, "config/hooks/live/01-lockdown.hook.chroot").replace("\\\n", " ")
        mask = re.search(r"(?m)^systemctl mask sleep\.target.*$", hook)
        self.assertIsNotNone(mask)
        for target in ("sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target",
                       "suspend-then-hibernate.target"):
            self.assertIn(target, mask.group(0).split())


class Hostname(unittest.TestCase):
    """Generated at installation or typed there; at boot, from the command line or the network card."""

    def run_script(self, cmdline, macs=(), name_file=None):
        """labkiosk-hostname against a fake /proc/cmdline, /sys/class/net and /etc."""
        tmp = tempfile.mkdtemp()
        self.addCleanup(subprocess.run, ["rm", "-rf", tmp])
        with open(os.path.join(tmp, "cmdline"), "w", encoding="utf-8") as handle:
            handle.write(cmdline + "\n")
        net = os.path.join(tmp, "net")
        os.mkdir(net)
        for index, (mac, assign_type, physical) in enumerate(macs):
            dev = os.path.join(net, f"eth{index}")
            os.mkdir(dev)
            if physical:
                os.mkdir(os.path.join(dev, "device"))
            for name, value in (("address", mac), ("addr_assign_type", str(assign_type))):
                with open(os.path.join(dev, name), "w", encoding="ascii") as handle:
                    handle.write(value + "\n")
        etc = os.path.join(tmp, "etc")
        os.mkdir(etc)
        with open(os.path.join(etc, "hosts"), "w", encoding="ascii") as handle:
            handle.write("127.0.0.1\tlocalhost\n127.0.1.1\tlocalhost.localdomain\n::1\tlocalhost\n")
        bin_dir = os.path.join(tmp, "bin")
        os.mkdir(bin_dir)
        fake = os.path.join(bin_dir, "hostname")
        with open(fake, "w", encoding="ascii") as handle:
            handle.write(f'#!/bin/sh\nprintf "%s\\n" "$1" > "{tmp}/set-hostname"\n')
        os.chmod(fake, 0o755)
        script = (read(HOSTNAME_PATH)
                  .replace("CMDLINE_FILE=/proc/cmdline", f"CMDLINE_FILE={tmp}/cmdline")
                  .replace("NET_CLASS_DIR=/sys/class/net", f"NET_CLASS_DIR={net}")
                  .replace("/etc/.hosts.", f"{etc}/.hosts.")
                  .replace("/etc/hostname", f"{etc}/hostname")
                  .replace("/etc/hosts", f"{etc}/hosts")
                  .replace("sleep 0.5", "sleep 0"))
        copy = os.path.join(tmp, "labkiosk-hostname")
        with open(copy, "w", encoding="utf-8") as handle:
            handle.write(script)
        result = subprocess.run(["sh", copy], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                env={"PATH": f"{bin_dir}:/usr/bin:/bin"})
        self.assertEqual(result.returncode, 0, result.stderr)
        set_name = read(tmp, "set-hostname").strip()
        self.assertEqual(read(etc, "hostname"), set_name + "\n")
        hosts = read(etc, "hosts")
        self.assertIn(f"127.0.1.1\t{set_name}\n", hosts)
        self.assertNotIn("localhost.localdomain", hosts)
        self.assertIn("127.0.0.1\tlocalhost\n", hosts)
        return set_name

    def test_the_name_on_the_command_line_is_used(self):
        self.assertEqual(self.run_script("boot=live labkiosk.hostname=front-desk-1"), "front-desk-1")

    def test_otherwise_the_name_comes_from_the_lowest_permanent_mac(self):
        macs = (("52:54:00:aa:bb:02", 0, True),
                ("52:54:00:aa:bb:01", 0, True),
                ("02:00:00:00:00:00", 1, True),      # random address: not the card's own
                ("00:11:22:33:44:55", 0, False))     # no device behind it: virtual
        expected = "labkiosk-" + hashlib.sha256(b"52:54:00:aa:bb:01").hexdigest()[:6]
        for cmdline in ("boot=live", "boot=live labkiosk.hostname=", "boot=live labkiosk.hostname=Bad_Name",
                        "boot=live labkiosk.hostname=-edge"):
            with self.subTest(cmdline=cmdline):
                self.assertEqual(self.run_script(cmdline, macs), expected)

    def test_without_a_network_card_the_name_is_random(self):
        name = self.run_script("boot=live")
        self.assertRegex(name, r"^labkiosk-[0-9a-f]{6}\Z")

    def test_the_installer_stores_a_generated_or_typed_name(self):
        for _ in range(20):
            self.assertRegex(installer.generate_hostname(), r"^labkiosk-[0-9a-f]{6}\Z")
        with tempfile.TemporaryDirectory() as grub_dir:
            installer.write_hostname(grub_dir, "front-desk-1")
            self.assertEqual(read(grub_dir, installer.HOSTNAME_FILE_NAME), 'set kiosk_hostname="front-desk-1"\n')
            for bad in ("", "Front", "-x", "x-", "a" * 64, 'x"; set superusers=""', "a\nb"):
                with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                    installer.write_hostname(grub_dir, bad)

    def test_the_agent_and_the_installer_accept_the_same_names(self):
        self.assertEqual(agent.INSTALL_HOSTNAME_PATTERN.pattern, installer.HOSTNAME_PATTERN.pattern)
        script_re = re.search(r"^LABEL_RE='([^']+)'$", read(HOSTNAME_PATH), re.MULTILINE).group(1)
        for name in ("a", "front-desk-1", "a" * 63, "", "A", "a_b", "-a", "a-", "a" * 64, "a.b"):
            with self.subTest(name=name):
                ours = bool(installer.HOSTNAME_PATTERN.match(name))
                theirs = re.fullmatch(script_re, name) is not None
                self.assertEqual(ours, theirs)

    def test_grub_passes_the_stored_name(self):
        cfg = read(CHROOT, "usr/share/labkiosk/boot/grub.cfg")
        self.assertIn(installer.HOSTNAME_FILE_NAME, cfg)
        for args in kernel_lines():
            self.assertIn("labkiosk.hostname=$kiosk_hostname", args)

    def test_the_wizard_sends_a_typed_name_only_when_the_box_is_ticked(self):
        wizard = read(CHROOT, "opt/labkiosk/setup/wizard.html")
        for marker in ('id="toggle-custom-hostname"', 'id="custom-hostname"',
                       "JSON.stringify({ targetDisk: disk, grubPasswordHash, hostname })"):
            self.assertIn(marker, wizard)
        typed = wizard.index("customHostnameInput.value.trim().toLowerCase()")
        self.assertIn("toggleCustomHostname.checked", wizard[typed - 200:typed])

    def test_the_service_runs_before_the_network(self):
        unit = read(CHROOT, "etc/systemd/system/labkiosk-hostname.service")
        self.assertIn("Before=network-pre.target NetworkManager.service nodm.service", unit)
        self.assertIn("systemctl enable labkiosk-hostname.service",
                      read(ROOT, "config/hooks/live/01-lockdown.hook.chroot"))


class SecureBootState(unittest.TestCase):
    """What the wizard's diagnostics say about Secure Boot."""

    def state(self, value=None, efi=True):
        with tempfile.TemporaryDirectory() as tmp:
            efi_dir = os.path.join(tmp, "efi")
            var = os.path.join(efi_dir, "SecureBoot")
            if efi:
                os.mkdir(efi_dir)
            if value is not None:
                with open(var, "wb") as handle:
                    handle.write(value)
            return agent.secure_boot_state(efi_dir=efi_dir, var_path=var)

    def test_the_states(self):
        attributes = b"\x06\x00\x00\x00"
        self.assertEqual(self.state(attributes + b"\x01"), "on")
        self.assertEqual(self.state(attributes + b"\x00"), "off")
        self.assertEqual(self.state(None), "off")
        self.assertEqual(self.state(None, efi=False), "legacy-bios")
        self.assertEqual(self.state(attributes), "unknown")
        self.assertEqual(self.state(attributes + b"\x01\x00"), "unknown")

    def test_the_installed_disk_boots_through_the_signed_loaders(self):
        source = read(CHROOT, "usr/local/bin/labkiosk-install")
        uefi = [block for block in source.split("run_cmd([")[1:] if '"--target=x86_64-efi"' in block]
        self.assertEqual(len(uefi), 2)
        for block in uefi:
            self.assertIn('"--uefi-secure-boot"', block.split("]")[0])
        packages = package_list()
        for package in ("shim-signed", "grub-efi-amd64-signed"):
            self.assertIn(package, packages)


class GraphicsAcceleration(unittest.TestCase):
    """Video decoded on the GPU, Intel (Arc included), AMD and Radeon."""

    def test_the_va_api_drivers_are_listed(self):
        packages = package_list()
        for package in ("intel-media-va-driver-non-free", "i965-va-driver", "mesa-va-drivers"):
            self.assertIn(package, packages)

    def test_chromium_uses_them(self):
        autostart = read(CHROOT, "etc/openbox/autostart")
        features = re.search(r'^CHROMIUM_GPU_FEATURES="([^"]+)"$', autostart, re.MULTILINE).group(1).split(",")
        for feature in ("AcceleratedVideoDecodeLinuxGL", "VaapiVideoDecoder"):
            self.assertIn(feature, features)
        self.assertIn('--enable-features="$CHROMIUM_GPU_FEATURES"', autostart)
        # Chromium honours only the last --enable-features; a second one would drop these.
        self.assertEqual(autostart.count("--enable-features"), 1)
        self.assertIn("--enable-zero-copy", autostart)

    def test_i915_drives_arc(self):
        conf = read(CHROOT, "etc/modprobe.d/labkiosk-i915.conf")
        self.assertRegex(conf, r"(?m)^options i915 force_probe=\*$")


class FakeRun:
    """The commands labkiosk-data-unlock runs, answered from a table of results."""

    def __init__(self, answers=None):
        self.calls = []
        self.answers = answers or {}

    def __call__(self, command, check=True, env=None):
        self.calls.append(command)
        for key, (code, out, err) in self.answers.items():
            if key in " ".join(command):
                if check and code != 0:
                    raise RuntimeError(f"{command[0]} failed ({code}): {err}")
                return subprocess.CompletedProcess(command, code, stdout=out, stderr=err)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    def ran(self, fragment):
        return [call for call in self.calls if fragment in " ".join(call)]


class DataUnlockArguments(unittest.TestCase):

    def test_volume_ids(self):
        installed = ["boot=live", "labkiosk.installed=1"]
        self.assertIsNone(unlock.volume_ids(["boot=live", f"labkiosk.datacrypt={CRYPT_ID}"]))
        self.assertIsNone(unlock.volume_ids(installed + [f"labkiosk.data={DATA_ID}"]))
        self.assertIsNone(unlock.volume_ids(installed + [f"labkiosk.data={DATA_ID}", "labkiosk.datacrypt="]))
        self.assertEqual(unlock.volume_ids(installed + [f"labkiosk.data={DATA_ID}", f"labkiosk.datacrypt={CRYPT_ID}"]),
                         (CRYPT_ID, DATA_ID))
        for bad in ([f"labkiosk.datacrypt={CRYPT_ID}"],
                    [f"labkiosk.data=x", f"labkiosk.datacrypt={CRYPT_ID}"],
                    [f"labkiosk.data={DATA_ID}", "labkiosk.datacrypt=../../dev/sda"]):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                unlock.volume_ids(installed + bad)

    def test_tpm_detection_needs_a_version_2_chip(self):
        with tempfile.TemporaryDirectory() as tmp:
            device = os.path.join(tmp, "tpmrm0")
            class_dir = os.path.join(tmp, "class")
            os.makedirs(os.path.join(class_dir, "tpm0"))
            version = os.path.join(class_dir, "tpm0", "tpm_version_major")
            for module, check in ((unlock, lambda: unlock.tpm2_present(class_dir)),
                                  (installer, lambda: installer.tpm2_available(class_dir, device))):
                with self.subTest(module=module.__name__):
                    original = getattr(module, "TPM_DEVICE")
                    module.TPM_DEVICE = device
                    try:
                        for path in (device, version):
                            if os.path.exists(path):
                                os.remove(path)
                        self.assertFalse(check())
                        open(device, "w").close()
                        self.assertFalse(check())
                        with open(version, "w") as handle:
                            handle.write("1\n")
                        self.assertFalse(check())
                        with open(version, "w") as handle:
                            handle.write("2\n")
                        self.assertTrue(check())
                    finally:
                        module.TPM_DEVICE = original


class DataUnlockFlows(unittest.TestCase):
    """What a boot does with the encrypted data partition."""

    DEVICE = "/dev/sda4"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(subprocess.run, ["rm", "-rf", self.tmp])
        self.key = os.path.join(self.tmp, "labkiosk-data.key")
        self.mapper = os.path.join(self.tmp, "mapper")
        self.state = {"tpm": True, "unlocks": True}
        self.run = FakeRun({
            "--test-passphrase": (0, "Key slot 0 unlocked.\nCommand successful.\n", ""),
        })
        self.writable = []
        self.real_unlock_with_tpm = unlock.unlock_with_tpm
        patches = {
            "run": self.run,
            "kernel_args": lambda: ["labkiosk.installed=1", f"labkiosk.data={DATA_ID}",
                                    f"labkiosk.datacrypt={CRYPT_ID}"],
            "wait_for": lambda path, seconds=0: True,
            "tpm2_present": lambda: self.state["tpm"],
            "unlock_with_tpm": lambda device: self.state["unlocks"],
            "FIRST_BOOT_KEY": self.key,
            "MAPPER_DEV": self.mapper,
            "boot_medium_writable": self.fake_writable,
        }
        for name, value in patches.items():
            self.addCleanup(setattr, unlock, name, getattr(unlock, name))
            setattr(unlock, name, value)
        original_realpath = os.path.realpath
        self.addCleanup(setattr, unlock.os.path, "realpath", original_realpath)
        unlock.os.path.realpath = lambda path: self.DEVICE if path.startswith("/dev/disk/") else original_realpath(path)
        # first_boot's default argument was bound at definition time.
        self.addCleanup(setattr, unlock.first_boot, "__defaults__", unlock.first_boot.__defaults__)
        unlock.first_boot.__defaults__ = (self.key,)

    def fake_writable(self):
        test = self

        class Writable:
            def __enter__(self):
                test.writable.append("rw")

            def __exit__(self, *exc):
                test.writable.append("ro")
                return False

        return Writable()

    def write_key(self):
        with open(self.key, "w", encoding="ascii") as handle:
            handle.write("ab" * 32)

    def test_first_boot_seals_to_the_tpm_and_destroys_the_one_time_key(self):
        self.write_key()
        self.assertEqual(unlock.command_start(), 0)
        self.assertTrue(self.run.ran(f"cryptsetup open --key-file={self.key} {self.DEVICE} labkiosk-data"))
        enroll = self.run.ran("systemd-cryptenroll")
        self.assertEqual(enroll, [["systemd-cryptenroll", f"--unlock-key-file={self.key}", "--tpm2-device=auto",
                                   "--tpm2-pcrs=7", self.DEVICE]])
        self.assertEqual(self.run.ran("luksKillSlot"),
                         [["cryptsetup", "luksKillSlot", "--batch-mode", self.DEVICE, "0"]])
        self.assertFalse(os.path.exists(self.key))
        self.assertEqual(self.writable, ["rw", "ro"])
        self.assertFalse(self.run.ran("luksFormat"))

    def test_first_boot_without_a_tpm_keeps_the_key(self):
        self.write_key()
        self.state["tpm"] = False
        self.assertEqual(unlock.command_start(), 0)
        self.assertTrue(os.path.exists(self.key))
        self.assertFalse(self.run.ran("systemd-cryptenroll"))
        self.assertFalse(self.run.ran("luksFormat"))

    def test_a_stale_one_time_key_is_removed_and_the_tpm_opens_the_volume(self):
        self.write_key()
        self.run.answers = {"--key-file": (2, "", "No key available with this passphrase.")}
        self.assertEqual(unlock.command_start(), 0)
        self.assertFalse(os.path.exists(self.key))
        self.assertFalse(self.run.ran("luksFormat"))
        self.assertFalse(self.run.ran("systemd-cryptenroll"))

    def test_every_later_boot_unlocks_with_the_tpm(self):
        self.assertEqual(unlock.command_start(), 0)
        self.assertEqual(self.run.calls, [])

    def test_no_tpm_leaves_the_partition_locked_and_untouched(self):
        self.state.update(tpm=False, unlocks=False)
        self.assertEqual(unlock.command_start(), 0)
        self.assertEqual(self.run.calls, [])

    def test_a_tpm_that_no_longer_releases_the_key_gets_a_new_empty_volume(self):
        self.state["unlocks"] = False
        original = unlock.recreate.__defaults__
        self.addCleanup(setattr, unlock.recreate, "__defaults__", original)
        unlock.recreate.__defaults__ = (self.tmp,)
        self.assertEqual(unlock.command_start(), 0)
        commands = [" ".join(call[:2]) for call in self.run.calls]
        self.assertEqual(commands, ["cryptsetup luksFormat", "cryptsetup open", "mkfs.ext4 -q",
                                    "systemd-cryptenroll --unlock-key-file=" + self.run.calls[3][1].split("=", 1)[1],
                                    "cryptsetup open", "cryptsetup luksKillSlot"])
        luks_format = self.run.calls[0]
        self.assertIn(f"--uuid={CRYPT_ID}", luks_format)
        self.assertEqual(luks_format[-1], self.DEVICE)
        self.assertIn(DATA_ID, self.run.calls[2])
        self.assertIn("LABKIOSK_DATA", self.run.calls[2])
        # The temporary key never outlives the call.
        self.assertEqual([name for name in os.listdir(self.tmp) if name.endswith(".key")], [])

    def test_an_unencrypted_disk_does_nothing(self):
        unlock.kernel_args = lambda: ["labkiosk.installed=1", f"labkiosk.data={DATA_ID}"]
        self.state.update(unlocks=False)
        self.assertEqual(unlock.command_start(), 0)
        self.assertEqual(self.run.calls, [])

    def test_an_unknown_key_slot_is_an_error_not_a_guess(self):
        self.run.answers = {"--test-passphrase": (0, "Command successful.\n", "")}
        with self.assertRaises(RuntimeError):
            unlock.seal_to_tpm(self.DEVICE, self.key)
        self.assertFalse(self.run.ran("luksKillSlot"))

    def test_every_unlock_route_is_tried_before_the_volume_is_recreated(self):
        self.addCleanup(setattr, unlock, "unlock_with_tpm", unlock.unlock_with_tpm)
        unlock.unlock_with_tpm = self.real_unlock_with_tpm
        self.run.answers = {"attach": (1, "", "TPM2 operation failed\nsecond line"),
                            "--token-only": (1, "", "No usable token")}
        self.assertFalse(unlock.unlock_with_tpm(self.DEVICE, attempts=2, pause=0))
        routes = [" ".join(call[:2]) for call in self.run.calls]
        self.assertEqual(routes, ["/lib/systemd/systemd-cryptsetup attach", "/lib/systemd/systemd-cryptsetup attach",
                                  "cryptsetup open"] * 2)
        for name, command, env in unlock.unlock_commands(self.DEVICE):
            with self.subTest(name=name):
                self.assertIn(self.DEVICE, command)
                if command[0] == unlock.SYSTEMD_CRYPTSETUP:
                    self.assertIn("tpm2-device=auto,headless=true", command)
                else:
                    self.assertIn("--token-only", command)

    def test_the_first_route_that_opens_the_volume_wins(self):
        self.addCleanup(setattr, unlock, "unlock_with_tpm", unlock.unlock_with_tpm)
        unlock.unlock_with_tpm = self.real_unlock_with_tpm
        open(self.mapper, "w").close()
        self.assertTrue(unlock.unlock_with_tpm(self.DEVICE, attempts=3, pause=0))
        self.assertEqual(len(self.run.calls), 1)

    def test_nothing_waits_for_a_passphrase(self):
        source = read(UNLOCK_PATH)
        self.assertIn("stdin=subprocess.DEVNULL", source)
        self.assertIn("headless=true", source)


class EncryptedDataInstall(unittest.TestCase):
    """What the installer writes for an encrypted data partition."""

    def test_the_container_is_luks2_with_ext4_inside(self):
        calls = []
        orig = installer.run_cmd
        self.addCleanup(setattr, installer, "run_cmd", orig)
        installer.run_cmd = lambda cmd, check=True: calls.append(cmd) or ""
        device = installer.format_encrypted_data("/dev/sda4", "/run/key")
        self.assertEqual(device, f"/dev/mapper/{installer.DATA_MAPPER_NAME}")
        self.assertEqual(calls[0][:5], ["cryptsetup", "luksFormat", "--batch-mode", "--type", "luks2"])
        self.assertEqual(calls[0][-2:], ["--key-file=/run/key", "/dev/sda4"])
        self.assertEqual(calls[1], ["cryptsetup", "open", "--key-file=/run/key", "/dev/sda4",
                                    installer.DATA_MAPPER_NAME])
        self.assertEqual(calls[2], ["mkfs.ext4", "-F", "-L", "LABKIOSK_DATA", device])

    def test_the_key_is_random_and_root_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            first, second = installer.write_data_key(tmp), installer.write_data_key(tmp)
            self.assertEqual(stat.S_IMODE(os.stat(first).st_mode), 0o600)
            self.assertRegex(read(first), r"^[0-9a-f]{64}\Z")
            self.assertNotEqual(read(first), read(second))

    def test_the_container_uuid_is_recorded_for_grub(self):
        orig = installer.run_cmd
        self.addCleanup(setattr, installer, "run_cmd", orig)
        with tempfile.TemporaryDirectory() as grub_dir:
            installer.run_cmd = lambda cmd, check=True: CRYPT_ID
            installer.write_data_crypt_id(grub_dir, "/dev/sda4")
            self.assertEqual(read(grub_dir, installer.DATA_CRYPT_FILE_NAME), f'set data_luks_uuid="{CRYPT_ID}"\n')
            installer.run_cmd = lambda cmd, check=True: 'x"; set superusers=""'
            with self.assertRaises(RuntimeError):
                installer.write_data_crypt_id(grub_dir, "/dev/sda4")

    def test_the_first_boot_key_is_where_the_unlock_looks(self):
        self.assertEqual(os.path.basename(unlock.FIRST_BOOT_KEY), installer.FIRST_BOOT_KEY_FILE_NAME)
        self.assertEqual(os.path.dirname(unlock.FIRST_BOOT_KEY), "/run/live/medium/boot/grub")

    def test_grub_names_the_container(self):
        cfg = read(CHROOT, "usr/share/labkiosk/boot/grub.cfg")
        self.assertIn(installer.DATA_CRYPT_FILE_NAME, cfg)
        for args in kernel_lines():
            self.assertIn("labkiosk.datacrypt=$data_luks_uuid", args)

    def test_the_unlock_runs_before_the_data_partition_is_mounted(self):
        unit = read(CHROOT, "etc/systemd/system/labkiosk-data-unlock.service")
        self.assertIn("Before=etc-labkiosk.mount labkiosk-data-permissions.service local-fs.target", unit)
        self.assertIn("DefaultDependencies=no", unit)
        self.assertIn("ConditionKernelCommandLine=labkiosk.installed=1", unit)
        hook = read(ROOT, "config/hooks/live/01-lockdown.hook.chroot")
        self.assertIn("systemctl enable labkiosk-data-unlock.service", hook)
        self.assertIn("/usr/local/sbin/labkiosk-data-unlock", hook.split("systemctl enable labkiosk-data-unlock")[0])

    def test_systemd_can_reach_the_tpm(self):
        packages = package_list()
        for package in ("cryptsetup-bin", "libtss2-esys-3.0.2-0", "libtss2-mu0", "libtss2-rc0",
                        "libtss2-tcti-device0"):
            self.assertIn(package, packages)

    def test_swap_checks_the_disk_through_the_container(self):
        script = read(CHROOT, "usr/local/sbin/labkiosk-swap")
        with tempfile.TemporaryDirectory() as tmp:
            cmdline_file = os.path.join(tmp, "cmdline")
            with open(cmdline_file, "w", encoding="utf-8") as handle:
                handle.write(f"boot=live labkiosk.installed=1 labkiosk.data={DATA_ID} "
                             f"labkiosk.swap={DATA_ID} labkiosk.datacrypt=/dev/sda1\n")
            copy = os.path.join(tmp, "swap")
            with open(copy, "w", encoding="utf-8") as handle:
                handle.write(script.replace("/proc/cmdline", cmdline_file))
            result = subprocess.run(["sh", copy, "start"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, env={"PATH": "/usr/bin:/bin"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("labkiosk.datacrypt=/dev/sda1 is not a UUID", result.stderr)
            self.assertNotIn("Swap on", result.stderr)


if __name__ == "__main__":
    unittest.main()
