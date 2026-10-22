#!/usr/bin/env python3
"""
A pre-configured install stick (tools/labkiosk-iso.py customize).

The tool writes the settings file into a copy of a release ISO; the agent of
a live session started from it reads and applies it, and keeps the enrolment
for the installed system, which enrols with it at its first start. These run
without root, a VM or a network; the VM boot test (tests/vm/boot-test.sh,
group preset) boots a customized release ISO, installs it and sees the
installed workstation register itself.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROOT = os.path.join(ROOT, "config", "includes.chroot")
KEY = "AAAAA-AAAAA-AAAAA-AAAAA"
DIGEST = "grub.pbkdf2.sha512.10000." + "AB" * 32 + "." + "CD" * 64


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


agent = load("labkiosk_agent_preset", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))
tool = load("labkiosk_iso", os.path.join(ROOT, "tools", "labkiosk-iso.py"))
agent.log = lambda message: None


def preset(**sections):
    doc = {"version": 1}
    doc.update(sections)
    return doc


ORG = {"subdomain": "oakridge", "enrollmentKey": KEY}
WIFI = {"ssid": "Staff Net", "password": "a passphrase", "hidden": False, "security": "WPA2"}


class TheSettingsFile(unittest.TestCase):
    def test_a_full_preset_is_normalised(self):
        got = agent.validate_preset(preset(
            organization={"subdomain": "OakRidge", "enrollmentKey": KEY.lower(), "server": "https://kiosk.example.org"},
            wifi=WIFI, localization={"timezone": "Europe/Berlin", "keymap": "de", "keymapVariant": "nodeadkeys"},
            bootPasswordHash=DIGEST))
        self.assertEqual(got["organization"], {"subdomain": "oakridge", "customDomain": "", "key": KEY,
                                               "server": "https://kiosk.example.org"})
        self.assertEqual(got["wifi"], WIFI)
        self.assertEqual(got["localization"], {"timezone": "Europe/Berlin", "locale": "", "keymap": "de",
                                               "keymapVariant": "nodeadkeys"})
        self.assertEqual(got["bootPasswordHash"], DIGEST)

    def test_each_part_is_optional_but_not_all(self):
        self.assertIsNone(agent.validate_preset(preset(organization=ORG))["wifi"])
        self.assertIsNone(agent.validate_preset(preset(wifi=WIFI))["organization"])
        with self.assertRaisesRegex(ValueError, "sets nothing"):
            agent.validate_preset(preset())

    def test_wrong_settings_are_refused(self):
        for doc in (
            [],
            {"version": 2, "organization": ORG},
            preset(organization=ORG, extra=1),
            preset(organization={"subdomain": "oakridge", "customDomain": "kiosk.example.org", "enrollmentKey": KEY}),
            preset(organization={"enrollmentKey": KEY}),
            preset(organization={"subdomain": "-bad-", "enrollmentKey": KEY}),
            preset(organization={"subdomain": "oakridge", "enrollmentKey": "AAAAA-AAAAA-AAAAA-AAAAB"}),
            preset(organization={"subdomain": "oakridge", "enrollmentKey": KEY, "server": "ftp://x"}),
            preset(organization={"subdomain": "oakridge", "enrollmentKey": KEY, "token": "x"}),
            preset(wifi={"ssid": "Net", "password": ""}),
            preset(wifi={"ssid": "Net", "password": "short"}),
            preset(wifi={"ssid": "Net", "password": "a passphrase", "security": "OPEN"}),
            preset(wifi={"ssid": "", "password": "a passphrase"}),
            preset(wifi={"ssid": "Net", "password": "a passphrase", "hidden": "yes"}),
            preset(wifi={"ssid": "Net", "password": "a passphrase", "security": "WEP"}),
            preset(localization={"timezone": "Europe/Berlin; rm -rf /"}),
            preset(localization={"keymap": "-x"}),
            preset(localization={"keymapVariant": "nodeadkeys"}),
            preset(localization={"uiLanguage": "de-DE"}),
            preset(bootPasswordHash="password"),
        ):
            with self.subTest(doc=doc), self.assertRaises(ValueError):
                agent.validate_preset(doc)

    def test_reading_it(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = os.path.join(scratch, "preset.json")
            self.assertIsNone(agent.read_preset(path))
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(preset(organization=ORG), handle)
            self.assertEqual(agent.read_preset(path)["organization"]["subdomain"], "oakridge")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{not json")
            with self.assertRaisesRegex(ValueError, "not valid JSON"):
                agent.read_preset(path)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(" " * (agent.PRESET_MAX_BYTES + 1))
            with self.assertRaisesRegex(ValueError, "larger than"):
                agent.read_preset(path)

    def test_the_wizard_never_sees_the_key_or_the_passphrase(self):
        summary = agent.preset_summary(agent.validate_preset(preset(organization=ORG, wifi=WIFI, bootPasswordHash=DIGEST)))
        text = json.dumps(summary)
        self.assertNotIn(KEY, text)
        self.assertNotIn(WIFI["password"], text)
        self.assertEqual((summary["organization"], summary["wifiSsid"], summary["bootPassword"]),
                         ("oakridge", "Staff Net", True))

    def test_the_agent_reads_it_from_the_stick_and_apparmor_allows_it(self):
        self.assertEqual(agent.PRESET_FILE, "/run/live/medium" + tool.PRESET_PATH)
        with open(os.path.join(CHROOT, "etc/apparmor.d/labkiosk-agent"), encoding="utf-8") as handle:
            self.assertIn(f"  {agent.PRESET_FILE} r,\n", handle.read())
        self.assertEqual(agent.PRESET_VERSION, tool.PRESET_VERSION)
        self.assertEqual(agent.PRESET_SETTING_PATTERN.pattern, tool.SETTING_PATTERN.pattern)


class LiveSessionFromTheStick(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.scratch)
        self.preset_file = os.path.join(self.scratch, "preset.json")
        self.enrolment_file = os.path.join(self.scratch, "etc", "preset-enrolment.json")
        patcher = mock.patch.object(agent, "PRESET_ENROLMENT_FILE", self.enrolment_file)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.orig_state = (agent.state["preset"], agent.state["isConfigured"])
        agent.state["isConfigured"] = False
        self.addCleanup(self.restore)

    def restore(self):
        agent.state["preset"], agent.state["isConfigured"] = self.orig_state

    def write(self, doc):
        with open(self.preset_file, "w", encoding="utf-8") as handle:
            json.dump(doc, handle)

    def apply(self, saved_localization=None, wifi_profile=False, network_error=None):
        sleeps = []
        with mock.patch.object(agent, "load_localization_config", return_value=saved_localization or {}), \
                mock.patch.object(agent, "configure_localization") as localize, \
                mock.patch.object(agent, "wifi_profile_exists", return_value=wifi_profile), \
                mock.patch.object(agent, "configure_network", side_effect=network_error) as network:
            agent.apply_preset(self.preset_file, sleep=sleeps.append)
        return localize, network, sleeps

    def test_everything_is_applied_and_the_enrolment_kept_for_the_disk(self):
        self.write(preset(organization=ORG, wifi=WIFI, localization={"timezone": "Europe/Berlin"}))
        localize, network, _ = self.apply()
        localize.assert_called_once_with({"timezone": "Europe/Berlin", "locale": "", "keymap": "", "keymapVariant": ""})
        network.assert_called_once_with({"interfaceType": "wifi", "ssid": "Staff Net", "password": "a passphrase",
                                         "hidden": False, "security": "WPA2"})
        self.assertEqual(agent.state["preset"]["problems"], [])
        self.assertFalse(agent.state["preset"]["applying"])
        self.assertEqual(stat.S_IMODE(os.stat(self.enrolment_file).st_mode), 0o600)
        with open(self.enrolment_file, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), {"subdomain": "oakridge", "customDomain": "", "enrollmentKey": KEY,
                                                 "server": None})

    def test_what_a_person_already_chose_wins(self):
        self.write(preset(wifi=WIFI, localization={"timezone": "Europe/Berlin"}))
        localize, network, _ = self.apply(saved_localization={"timezone": "Asia/Kolkata"}, wifi_profile=True)
        localize.assert_not_called()
        network.assert_not_called()

    def test_a_wifi_that_never_connects_is_reported_and_the_rest_still_applies(self):
        self.write(preset(organization=ORG, wifi=WIFI))
        _, network, sleeps = self.apply(network_error=RuntimeError("The connection did not come up"))
        self.assertEqual(network.call_count, agent.PRESET_WIFI_ATTEMPTS)
        self.assertEqual(sleeps, [agent.PRESET_WIFI_RETRY_SECONDS] * (agent.PRESET_WIFI_ATTEMPTS - 1))
        self.assertEqual(len(agent.state["preset"]["problems"]), 1)
        self.assertIn("Staff Net", agent.state["preset"]["problems"][0])
        self.assertTrue(os.path.exists(self.enrolment_file))

    def test_wrong_settings_are_shown_and_nothing_is_applied(self):
        self.write(preset(organization={"subdomain": "oakridge", "enrollmentKey": "AAAAA-AAAAA-AAAAA-AAAAB"}))
        localize, network, _ = self.apply()
        self.assertIn("enrollment key", agent.state["preset"]["error"])
        localize.assert_not_called()
        network.assert_not_called()
        self.assertFalse(os.path.exists(self.enrolment_file))

    def test_no_stick_no_preset(self):
        self.apply()
        self.assertIsNone(agent.state["preset"])

    def test_an_enrolled_session_keeps_no_key(self):
        agent.state["isConfigured"] = True
        self.write(preset(organization=ORG))
        self.apply()
        self.assertFalse(os.path.exists(self.enrolment_file))


class InstalledFromTheStick(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.scratch)
        self.path = os.path.join(self.scratch, "preset-enrolment.json")
        self.orig_configured = agent.state["isConfigured"]
        agent.state["isConfigured"] = False
        self.addCleanup(lambda: agent.state.__setitem__("isConfigured", self.orig_configured))

    def write(self, doc):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(doc, handle)

    def run_loop(self, enroll_effects, hostname="labkiosk-3fa92c"):
        sleeps = []
        with mock.patch.object(agent.socket, "gethostname", return_value=hostname), \
                mock.patch.object(agent, "enroll", side_effect=enroll_effects) as enroll:
            agent.preset_enrol_loop(self.path, sleep=sleeps.append)
        return enroll, sleeps

    def test_it_enrols_under_its_hostname_then_forgets_the_key(self):
        self.write({"subdomain": "oakridge", "customDomain": "", "enrollmentKey": KEY, "server": None})
        enroll, sleeps = self.run_loop([agent.EnrolmentUnreachable("No network yet."), {"status": "ok"}])
        self.assertEqual(enroll.call_args_list, [mock.call("oakridge", "LABKIOSK-3FA92C", KEY, None, "")] * 2)
        self.assertEqual(sleeps, [agent.NETBOOT_RETRY_SECONDS])
        self.assertFalse(os.path.exists(self.path))

    def test_enrolled_by_hand_it_only_forgets_the_key(self):
        agent.state["isConfigured"] = True
        self.write({"subdomain": "oakridge", "enrollmentKey": KEY})
        enroll, _ = self.run_loop([])
        enroll.assert_not_called()
        self.assertFalse(os.path.exists(self.path))

    def test_an_unusable_file_is_left_alone(self):
        self.write({"subdomain": "oakridge", "enrollmentKey": "nope"})
        enroll, _ = self.run_loop([])
        enroll.assert_not_called()
        self.assertTrue(os.path.exists(self.path))

    def test_nothing_to_do_without_one(self):
        enroll, _ = self.run_loop([])
        enroll.assert_not_called()

    def test_the_installer_carries_it_to_the_disk(self):
        # seed_data_partition copies every regular file of /etc/labkiosk.
        self.assertEqual(os.path.dirname(agent.PRESET_ENROLMENT_FILE), os.path.dirname(agent.CONFIG_FILE))
        with open(os.path.join(CHROOT, "usr/local/bin/labkiosk-install"), encoding="utf-8") as handle:
            self.assertIn('source_config_dir = "/etc/labkiosk"', handle.read())


class LocalApiWithTheStick(unittest.TestCase):
    def handler(self, path, body):
        handler = object.__new__(agent.LocalApiHandler)
        handler.path = path
        handler.headers = {"Host": "127.0.0.1:8888"}
        handler.sent = None
        handler._send = lambda status, payload, content_type="application/json": setattr(handler, "sent", (status, payload))
        handler._read_json = lambda: body
        return handler

    def test_install_uses_the_sticks_password_unless_one_is_typed(self):
        stick = agent.validate_preset(preset(bootPasswordHash=DIGEST))
        other = "grub.pbkdf2.sha512.10000." + "EF" * 32 + "." + "01" * 64
        for body, expected in (({"targetDisk": "/dev/sda"}, DIGEST),
                               ({"targetDisk": "/dev/sda", "grubPasswordHash": other}, other)):
            handler = self.handler("/api/install", body)
            with mock.patch.object(agent, "is_live_session", return_value=True), \
                    mock.patch.object(agent, "is_network_boot", return_value=False), \
                    mock.patch.object(agent, "read_preset", return_value=stick), \
                    mock.patch.object(agent, "start_disk_install") as start:
                handler.do_POST()
            self.assertEqual(handler.sent[0], 200)
            start.assert_called_once_with("/dev/sda", expected, None, False, None)

    def test_live_enrolment_takes_the_organization_and_key_from_the_stick(self):
        stick = agent.validate_preset(preset(organization=dict(ORG, server="https://kiosk.example.org")))
        handler = self.handler("/api/setup", {"clientId": "pc-07", "usePreset": True})
        orig = agent.state["isConfigured"]
        agent.state["isConfigured"] = False
        try:
            with mock.patch.object(agent, "is_live_session", return_value=True), \
                    mock.patch.object(agent, "is_network_boot", return_value=False), \
                    mock.patch.object(agent, "read_preset", return_value=stick), \
                    mock.patch.object(agent, "enroll", return_value={"status": "ok"}) as enroll:
                handler.do_POST()
        finally:
            agent.state["isConfigured"] = orig
        self.assertEqual(handler.sent, (200, {"status": "ok"}))
        enroll.assert_called_once_with("oakridge", "PC-07", KEY, "https://kiosk.example.org", "")

    def test_no_stick_no_preset_enrolment(self):
        handler = self.handler("/api/setup", {"clientId": "pc-07", "usePreset": True})
        with mock.patch.object(agent, "is_live_session", return_value=True), \
                mock.patch.object(agent, "is_network_boot", return_value=False), \
                mock.patch.object(agent, "read_preset", return_value=None), \
                mock.patch.object(agent, "enroll") as enroll:
            handler.do_POST()
        self.assertEqual(handler.sent[0], 400)
        enroll.assert_not_called()


@unittest.skipUnless(shutil.which("xorriso") and shutil.which("mkfs.vfat"), "needs xorriso and mkfs.vfat")
class CustomizeTool(unittest.TestCase):
    """The tool on a small hybrid ISO shaped like a release: a UEFI El Torito
    image that is also an appended EFI partition, and the live/ files."""

    def setUp(self):
        self.scratch = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.scratch)
        tree = os.path.join(self.scratch, "tree")
        for path in ("live/vmlinuz", "live/initrd.img", "live/filesystem.squashfs", "boot/grub/grub.cfg"):
            os.makedirs(os.path.join(tree, os.path.dirname(path)), exist_ok=True)
            with open(os.path.join(tree, path), "w", encoding="utf-8") as handle:
                handle.write(path + "\n")
        efi = os.path.join(tree, "boot/grub/efi.img")
        with open(efi, "wb") as handle:
            handle.truncate(1440 * 1024)
        subprocess.run(["mkfs.vfat", efi], check=True, stdout=subprocess.DEVNULL)
        self.iso = os.path.join(self.scratch, "release.iso")
        subprocess.run(["xorriso", "-as", "mkisofs", "-o", self.iso, "-V", "LABKIOSK", "-J", "-r",
                        "-e", "boot/grub/efi.img", "-no-emul-boot", "-isohybrid-gpt-basdat",
                        "-append_partition", "2", "0xef", efi, tree],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.out = os.path.join(self.scratch, "oakridge.iso")

    def run_tool(self, *argv, env=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env or {}, clear=False), redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                status = tool.main(list(argv))
            except SystemExit as exit_:
                status = exit_.code
        return status, stdout.getvalue(), stderr.getvalue()

    def extract(self, iso):
        target = os.path.join(self.scratch, "extracted.json")
        if os.path.exists(target):
            os.remove(target)
        subprocess.run(["xorriso", "-osirrox", "on", "-indev", iso, "-extract", tool.PRESET_PATH, target],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(target, encoding="utf-8") as handle:
            return json.load(handle)

    def test_the_copy_holds_settings_the_agent_accepts_and_boots_like_the_release(self):
        status, out, err = self.run_tool(
            "customize", "--iso", self.iso, "--out", self.out, "--org", "OakRidge", "--key", KEY.lower(),
            "--wifi-ssid", "Staff Net", "--timezone", "Europe/Berlin", "--keymap", "de", "--admin-hash", DIGEST,
            env={tool.WIFI_PASSWORD_ENV: "a passphrase"})
        self.assertEqual(status, 0, err)
        doc = self.extract(self.out)
        got = agent.validate_preset(doc)
        self.assertEqual(got["organization"]["key"], KEY)
        self.assertEqual(got["wifi"]["password"], "a passphrase")
        self.assertEqual(got["localization"]["timezone"], "Europe/Berlin")
        self.assertEqual(got["bootPasswordHash"], DIGEST)
        self.assertEqual(tool.boot_report(self.out), tool.boot_report(self.iso))
        self.assertTrue(any("UEFI" in line for line in tool.boot_report(self.out)))
        # The agent runs as the kiosk user: the folder and the file are open to it.
        listing = subprocess.run(["xorriso", "-indev", self.out, "-lsdl", "/labkiosk", "/labkiosk/preset.json"],
                                 capture_output=True, text=True, check=True).stdout
        self.assertRegex(listing, r"(?m)^dr-xr-xr-x .*'/labkiosk'$")
        self.assertRegex(listing, r"(?m)^-r--r--r-- .*'/labkiosk/preset.json'$")
        # Neither secret is printed.
        self.assertNotIn(KEY, out)
        self.assertNotIn("a passphrase", out)
        self.assertFalse(os.path.exists(self.out + ".partial"))

        status, out, _ = self.run_tool("show", "--iso", self.out)
        self.assertEqual(status, 0)
        self.assertIn('"subdomain": "oakridge"', out)
        self.assertNotIn(KEY, out)

        # A customized ISO can be customized again: the settings are replaced.
        again = os.path.join(self.scratch, "again.iso")
        status, _, err = self.run_tool("customize", "--iso", self.out, "--out", again, "--timezone", "Asia/Kolkata")
        self.assertEqual(status, 0, err)
        self.assertEqual(self.extract(again), {"version": 1, "localization": {"timezone": "Asia/Kolkata"}})

    def test_mistakes_fail_before_anything_is_written(self):
        for argv, env in (
            (["--org", "oakridge", "--key", "AAAAA-AAAAA-AAAAA-AAAAB"], {}),
            (["--org", "oakridge"], {}),
            (["--key", KEY], {}),
            (["--org", "oakridge", "--domain", "kiosk.example.org", "--key", KEY], {}),
            (["--timezone", "Europe/Berlin; rm"], {}),
            (["--keymap-variant", "nodeadkeys"], {}),
            (["--wifi-hidden"], {}),
            (["--wifi-ssid", "Net"], {tool.WIFI_PASSWORD_ENV: "short"}),
            (["--wifi-ssid", "Net", "--wifi-security", "open"], {tool.WIFI_PASSWORD_ENV: "a passphrase"}),
            (["--admin-hash", "password"], {}),
            ([], {}),
        ):
            with self.subTest(argv=argv):
                status, _, _ = self.run_tool("customize", "--iso", self.iso, "--out", self.out, *argv, env=env)
                self.assertNotEqual(status, 0)
                self.assertFalse(os.path.exists(self.out))

    def test_it_refuses_what_is_not_a_release_and_never_overwrites(self):
        status, _, err = self.run_tool("customize", "--iso", self.iso, "--out", self.iso, "--timezone", "UTC")
        self.assertEqual(status, 1)
        self.assertIn("already exists", err)
        empty = os.path.join(self.scratch, "empty")
        os.makedirs(empty)
        with open(os.path.join(empty, "README"), "w", encoding="utf-8") as handle:
            handle.write("not a release\n")
        other = os.path.join(self.scratch, "other.iso")
        subprocess.run(["xorriso", "-as", "mkisofs", "-o", other, empty], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        status, _, err = self.run_tool("customize", "--iso", other, "--out", self.out, "--timezone", "UTC")
        self.assertEqual(status, 1)
        self.assertIn("not a Lab Kiosk release ISO", err)
        self.assertFalse(os.path.exists(self.out))


if __name__ == "__main__":
    unittest.main()
