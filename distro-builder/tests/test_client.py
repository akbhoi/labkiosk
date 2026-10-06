#!/usr/bin/env python3
"""
Unit tests for the client's validators.

These are the functions that stand between a caller and a subprocess, a
filesystem path or the managed browser policy -- the ones where a mistake is a
security bug rather than a cosmetic one. The control plane has had a test suite
since the beginning; the workstation had none, so every one of these rules was
only as good as the last person to read it.

Standard library only, so CI needs nothing it does not already have:

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests

PYTHONPYCACHEPREFIX matters. These modules live inside config/includes.chroot,
which live-build copies verbatim into the image, so bytecode written beside them
would be shipped to workstations.
"""

import importlib.machinery
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROOT = os.path.join(ROOT, "config", "includes.chroot")


def load(name, path):
    """Import a module by path, including the ones with no .py suffix."""
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


agent = load("labkiosk_agent", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))
localization = load("labkiosk_localization", os.path.join(CHROOT, "usr/local/sbin/labkiosk-localization"))
lockkeys = load("labkiosk_lock_keys", os.path.join(CHROOT, "usr/local/bin/labkiosk-lock-keys"))
installer = load("labkiosk_install", os.path.join(CHROOT, "usr/local/bin/labkiosk-install"))
bootslots = load("labkiosk_boot_slots", os.path.join(CHROOT, "usr/local/sbin/labkiosk-boot-slots"))

agent.log = lambda message: None
localization.log = lambda message: None
bootslots.log = lambda message: None

HAVE_ZONEINFO = os.path.isdir(localization.ZONEINFO_DIR)


class FakeHeaders(dict):
    """Enough of http.client.HTTPMessage for the caller checks."""

    def get(self, key, default=None):
        return super().get(key, default)


def handler_with(headers):
    handler = object.__new__(agent.LocalApiHandler)
    handler.headers = FakeHeaders(headers)
    return handler


class LoopbackBoundary(unittest.TestCase):
    """Who is allowed to reach the agent's API at all."""

    def test_a_page_the_user_visited_is_refused(self):
        for origin in ("https://evil.example", "http://attacker.test:8080",
                       "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"):
            with self.subTest(origin=origin):
                self.assertFalse(handler_with({"Origin": origin})._is_local_caller())

    def test_loopback_and_the_kiosk_extension_are_allowed(self):
        for origin in ("http://127.0.0.1:8888", "http://localhost:8888",
                       agent.KIOSK_EXTENSION_ORIGIN):
            with self.subTest(origin=origin):
                self.assertTrue(handler_with({"Origin": origin})._is_local_caller())

    def test_no_origin_is_allowed_because_a_browser_always_sends_one(self):
        self.assertTrue(handler_with({})._is_local_caller())

    def test_a_rebound_host_header_is_refused(self):
        self.assertFalse(handler_with({"Host": "kiosk.evil.example"})._is_expected_host())
        self.assertTrue(handler_with({"Host": "127.0.0.1:8888"})._is_expected_host())


class WorkerUrls(unittest.TestCase):
    """A URL from the control plane ends up in window.location."""

    def test_a_non_http_scheme_is_refused(self):
        for url in ("javascript:alert(1)", "file:///etc/shadow", "data:text/html,<script>"):
            with self.subTest(url=url):
                # Falsy rather than None: the helper returns "" for a refusal.
                self.assertFalse(agent.safe_navigable_url(url))

    def test_plain_http_is_refused_for_a_public_host(self):
        self.assertFalse(agent.validate_worker_url("http://organization.example"))

    def test_https_is_accepted(self):
        self.assertTrue(agent.validate_worker_url("https://organization.labkiosk.org"))

    def test_http_is_accepted_only_for_loopback_and_the_container_gateway(self):
        for url in ("http://127.0.0.1:8787", "http://host.docker.internal:8787"):
            with self.subTest(url=url):
                self.assertTrue(agent.validate_worker_url(url))

    def test_http_is_accepted_for_a_dev_server_on_a_private_address(self):
        # `pnpm dev` on the host, reached from a Hyper-V/WSL VM or the LAN.
        for url in ("http://172.31.64.1:8787/", "http://192.168.1.20:8787", "http://10.0.0.5:8787"):
            with self.subTest(url=url):
                self.assertEqual(agent.validate_worker_url(url), url.rstrip("/"))

    def test_http_is_refused_for_public_link_local_and_lookalike_hosts(self):
        for url in (
            "http://8.8.8.8:8787",          # public address
            "http://172.32.0.1:8787",       # just outside 172.16.0.0/12
            "http://169.254.169.254",       # link-local (cloud metadata)
            "http://0.0.0.0:8787",          # unspecified
            "http://192.168.1.20.evil.com", # a hostname, not an address
            "http://[fd00::1]:8787",        # IPv6 ULA: not a dev host on the control plane
        ):
            with self.subTest(url=url):
                self.assertFalse(agent.validate_worker_url(url))


class CatalogKeysResolve(unittest.TestCase):
    """Every string key the wizard and kiosk bar use must exist in the en-US catalog.

    A key renamed in the markup but not in the catalog still shows its English
    fallback, so nothing looks broken -- but every translation of it is silently
    orphaned, in the image and on every workstation that downloaded one.
    """

    def test_every_referenced_key_is_in_the_catalog(self):
        import json
        import re
        with open(os.path.join(CHROOT, "opt/labkiosk/i18n/en-US.json"), encoding="utf-8") as handle:
            catalog = json.load(handle)
        for rel in ("opt/labkiosk/setup/wizard.html", "opt/labkiosk/extension/content.js", "opt/labkiosk/setup/blocked.html"):
            with open(os.path.join(CHROOT, rel), encoding="utf-8") as handle:
                source = handle.read()
            keys = set(re.findall(r'data-i18n(?:-[a-z]+)?="([a-z][A-Za-z0-9_.-]*)"', source))
            keys |= set(re.findall(r"""\bt\(\s*['"]([a-z][A-Za-z0-9_.-]*)['"]""", source))
            # Keys assigned from script (el.dataset.i18n = '...') are translated too.
            keys |= set(re.findall(r"""dataset\.i18n\s*=\s*['"]([a-z][A-Za-z0-9_.-]*)['"]""", source))
            with self.subTest(file=rel):
                self.assertGreater(len(keys), 5)
                self.assertEqual(sorted(k for k in keys if k not in catalog), [])


class OrganizationNameFromEnrolment(unittest.TestCase):
    """The Worker renamed schoolName to organizationName; both must be understood."""

    def test_the_new_key_is_read(self):
        self.assertEqual(agent.organization_name({"organizationName": "Acme"}, "acme"), "Acme")

    def test_an_older_worker_still_names_the_organization(self):
        self.assertEqual(agent.organization_name({"schoolName": "Greenwood"}, "greenwood"), "Greenwood")

    def test_the_new_key_wins_when_both_are_sent(self):
        reply = {"organizationName": "Acme Corp", "schoolName": "Acme Corp (old)"}
        self.assertEqual(agent.organization_name(reply, "acme"), "Acme Corp")

    def test_the_typed_address_is_the_last_resort(self):
        for reply in ({}, {"organizationName": "  "}, None):
            with self.subTest(reply=reply):
                self.assertEqual(agent.organization_name(reply, "acme"), "acme")


class InterfaceCatalogs(unittest.TestCase):
    """A catalog arrives from the control plane, so it is checked on the way in."""

    def test_a_catalog_must_be_an_object_of_strings(self):
        for bad in ([], "text", {"bar.home": 42}, {"bar.home": {"nested": "no"}}):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    agent.validate_catalog(bad)

    def test_too_many_entries_is_refused(self):
        oversized = {f"key.{n}": "x" for n in range(agent.CATALOG_MAX_KEYS + 1)}
        with self.assertRaises(ValueError):
            agent.validate_catalog(oversized)

    def test_a_long_value_is_cut_rather_than_rejected(self):
        cleaned = agent.validate_catalog({"bar.home": "x" * (agent.CATALOG_MAX_VALUE + 50)})
        self.assertEqual(len(cleaned["bar.home"]), agent.CATALOG_MAX_VALUE)

    def test_meta_keeps_only_the_two_fields_that_are_used(self):
        cleaned = agent.validate_catalog(
            {"_meta": {"name": "हिन्दी", "direction": "RTL", "script": "<img onerror=1>"}}
        )
        self.assertEqual(cleaned["_meta"], {"name": "हिन्दी", "direction": "rtl"})


class PersistentStorage(unittest.TestCase):
    """The check that tells a workstation it will forget its enrolment."""

    def _mounts(self, line):
        handle = tempfile.NamedTemporaryFile("w", suffix=".mounts", delete=False, encoding="utf-8")
        handle.write(line)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_a_real_partition_is_persistent(self):
        mounts = self._mounts("/dev/sda4 /etc/labkiosk ext4 rw,relatime 0 0\n")
        self.assertEqual(agent.mounted_fstype("/etc/labkiosk", mounts), "ext4")
        self.assertNotIn("ext4", agent.EPHEMERAL_FSTYPES)

    def test_an_overlay_is_not(self):
        # This is the state overlayroot's recurse=1 default leaves behind: the
        # path is mounted and writable, and empty again after a reboot.
        mounts = self._mounts("overlay /etc/labkiosk overlay rw,lowerdir=/x,upperdir=/y 0 0\n")
        self.assertEqual(agent.mounted_fstype("/etc/labkiosk", mounts), "overlay")
        self.assertIn("overlay", agent.EPHEMERAL_FSTYPES)

    def test_a_tmpfs_is_not(self):
        mounts = self._mounts("tmpfs /etc/labkiosk tmpfs rw,mode=1777 0 0\n")
        self.assertIn(agent.mounted_fstype("/etc/labkiosk", mounts), agent.EPHEMERAL_FSTYPES)

    def test_the_last_mount_at_a_path_is_the_one_that_counts(self):
        mounts = self._mounts(
            "/dev/sda4 /etc/labkiosk ext4 rw 0 0\n"
            "tmpfs /etc/labkiosk tmpfs rw 0 0\n"
        )
        self.assertEqual(agent.mounted_fstype("/etc/labkiosk", mounts), "tmpfs")

    def test_a_path_with_an_escaped_space(self):
        mounts = self._mounts("/dev/sdb1 /mnt/lab\\040data ext4 rw 0 0\n")
        self.assertEqual(agent.mounted_fstype("/mnt/lab data", mounts), "ext4")


class LocaleSpellings(unittest.TestCase):
    """Debian spells one locale three ways; the code has to agree with itself."""

    def test_the_three_spellings_are_one_locale(self):
        keys = {localization.locale_key(name) for name in ("en_IN", "en_IN.UTF-8", "en_IN.utf8")}
        self.assertEqual(len(keys), 1)

    def test_the_canonical_form_is_what_the_project_writes(self):
        self.assertEqual(localization.canonical_locale("en_IN"), "en_IN.UTF-8")
        self.assertEqual(localization.canonical_locale("sr_RS@latin"), "sr_RS.UTF-8@latin")

    def test_a_modifier_survives_normalisation(self):
        self.assertEqual(localization.locale_key("sr_RS.UTF-8@latin"), "sr_RS.utf8@latin")


class InterfaceLanguageTags(unittest.TestCase):
    """The helper once rejected every tag, en-US included, and broke installs."""

    GOOD = ("en-US", "en", "hi-IN", "zh-Hant-TW", "fil")
    BAD = ("", "en_US", "e", "en-", "en-US\n", "../en", "en US")

    def test_the_helper_accepts_the_tags_the_agent_offers(self):
        for good in self.GOOD:
            with self.subTest(tag=good):
                self.assertIsNotNone(localization.UI_LANGUAGE_PATTERN.match(good))
                self.assertIsNotNone(agent.UI_LANGUAGE_PATTERN.match(good))

    def test_both_reject_malformed_tags_and_trailing_newlines(self):
        for bad in self.BAD:
            with self.subTest(tag=bad):
                self.assertIsNone(localization.UI_LANGUAGE_PATTERN.match(bad))
                self.assertIsNone(agent.UI_LANGUAGE_PATTERN.match(bad))

    def test_the_two_patterns_are_the_same(self):
        self.assertEqual(localization.UI_LANGUAGE_PATTERN.pattern, agent.UI_LANGUAGE_PATTERN.pattern)

    def test_no_client_script_double_escapes_an_anchor(self):
        # In a raw string, \\Z means a literal backslash followed by Z, so the
        # pattern can never match. That is how en-US came to be refused.
        scripts = [
            "opt/labkiosk/agent/agent.py",
            "usr/local/bin/labkiosk-install",
            "usr/local/sbin/labkiosk-localization",
            "usr/local/sbin/labkiosk-boot-slots",
        ]
        for rel in scripts:
            with self.subTest(script=rel):
                with open(os.path.join(CHROOT, rel), encoding="utf-8") as handle:
                    source = handle.read()
                self.assertNotRegex(source, r"""r["'][^"'\n]*\\\\Z""")


class TimeServers(unittest.TestCase):
    def test_a_shell_fragment_is_refused(self):
        for bad in ("ntp.example.com; rm -rf /", "ntp.example.com\nNTP=evil", "a b c d e"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    localization.validate_ntp_servers(bad)

    def test_hosts_and_addresses_are_accepted(self):
        self.assertEqual(
            localization.validate_ntp_servers("ntp.example.com, 10.0.0.1"),
            ["ntp.example.com", "10.0.0.1"],
        )

    def test_empty_means_the_default_pool(self):
        self.assertEqual(localization.validate_ntp_servers("   "), [])


class ClockAndZone(unittest.TestCase):
    def test_a_clock_outside_living_memory_is_refused(self):
        for bad in ("1999-01-01 00:00:00", "2200-01-01 00:00:00", "yesterday", "2026-13-01 00:00:00"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    localization.validate_time(bad)

    def test_a_plausible_clock_is_accepted(self):
        self.assertEqual(localization.validate_time("2026-09-19 18:04:00").hour, 18)

    @unittest.skipUnless(HAVE_ZONEINFO, "tzdata is not installed")
    def test_a_path_is_not_a_timezone(self):
        for bad in ("../../etc/passwd", "/etc/passwd", "Mars/Olympus", "Asia/Kolkata; rm -rf /"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    localization.validate_timezone(bad)

    @unittest.skipUnless(HAVE_ZONEINFO, "tzdata is not installed")
    def test_a_real_zone_is_accepted(self):
        self.assertEqual(localization.validate_timezone("Asia/Kolkata"), "Asia/Kolkata")


class KeyboardLockdown(unittest.TestCase):
    """What labkiosk-lock-keys takes off the keyboard, and what it leaves."""

    KEYMAP = """xkb_keymap {
xkb_symbols "labkiosk" {
    key <FK01> {         [              F1 ] };
    key <LWIN> {         [         Super_L ] };
    key <MENU> {         [            Menu ] };
    key <PRSC> {         [           Print,        Sys_Req ] };
    key <AD01> {         [               q,              Q ] };
    key <BKSP> {         [       BackSpace,      BackSpace ] };
    key <LEFT> {         [            Left ] };
    key <KPMU> {
        type= "CTRL+ALT",
        symbols[Group1]= [     KP_Multiply,    KP_Multiply,    KP_Multiply,    KP_Multiply,   XF86ClearGrab ]
    };
};
};
"""

    def setUp(self):
        self.stripped, self.cleared, self.trimmed = lockkeys.strip_keys(self.KEYMAP)

    def test_the_escape_keys_are_cleared(self):
        for key in ("FK01", "LWIN", "MENU", "PRSC"):
            self.assertIn(key, self.cleared)

    def test_typing_keys_are_untouched(self):
        for key in ("AD01", "BKSP", "LEFT"):
            self.assertNotIn(key, self.cleared)
        self.assertIn("[               q,              Q ]", self.stripped)

    def test_the_keypad_keeps_typing_and_loses_its_ctrl_alt_escape(self):
        # KP_Multiply carries XF86ClearGrab on its Ctrl+Alt level in the stock
        # keymap. Reading that as the key's identity used to clear the key that
        # types "*".
        self.assertNotIn("KPMU", self.cleared)
        self.assertIn("KPMU", self.trimmed)
        self.assertIn("KP_Multiply", self.stripped)
        self.assertNotIn("XF86ClearGrab", self.stripped)

    def test_a_cleared_key_carries_nothing(self):
        for line in self.stripped.splitlines():
            if "<FK01>" in line:
                self.assertIn("NoSymbol", line)
                self.assertNotIn("F1", line.replace("NoSymbol", ""))


class GrubPasswordDigest(unittest.TestCase):
    """Only a digest crosses the API; the plaintext never leaves the browser."""

    def test_a_plaintext_password_is_not_a_digest(self):
        for bad in ("hunter2", "grub.pbkdf2.sha512.10000", "grub.pbkdf2.sha1.10000.AA.BB"):
            with self.subTest(bad=bad):
                self.assertIsNone(agent.GRUB_PBKDF2_PATTERN.match(bad))

    def test_a_real_digest_matches(self):
        digest = "grub.pbkdf2.sha512.10000." + "A" * 128 + "." + "B" * 128
        self.assertIsNotNone(agent.GRUB_PBKDF2_PATTERN.match(digest))


class WorkstationNames(unittest.TestCase):
    def test_a_name_that_could_reach_a_shell_or_a_path_is_refused(self):
        for bad in ("PC 01", "../PC-01", "PC-01;reboot", "", "pc-01\n"):
            with self.subTest(bad=bad):
                self.assertIsNone(agent.CLIENT_ID_PATTERN.match(bad.upper()))

    def test_ordinary_names_are_accepted(self):
        for good in ("PC-01", "LAB2_PC15", "A"):
            with self.subTest(good=good):
                self.assertIsNotNone(agent.CLIENT_ID_PATTERN.match(good))

    def test_a_target_disk_must_look_like_a_disk(self):
        for bad in ("/dev/sda1", "/dev/../sda", "/dev/sdaa", "sda"):
            with self.subTest(bad=bad):
                self.assertIsNone(agent.TARGET_DISK_PATTERN.match(bad))
        for good in ("/dev/sda", "/dev/nvme0n1", "/dev/mmcblk0"):
            with self.subTest(good=good):
                self.assertIsNotNone(agent.TARGET_DISK_PATTERN.match(good))


class RemoteReloadCommand(unittest.TestCase):
    def test_reload_action_advances_reload_epoch(self):
        initial = agent.state.get("reloadEpoch", 0)
        agent.execute_command({"action": "reload"})
        updated = agent.state.get("reloadEpoch", 0)
        self.assertGreater(updated, 0)
        self.assertGreaterEqual(updated, initial)


class RemoteClearSessionCommand(unittest.TestCase):
    """clear-session ends the kiosk browser; the watchdog wipes its profile."""

    def setUp(self):
        self._run = agent.subprocess.run
        self.calls = []

        def fake_run(argv, **kwargs):
            self.calls.append(list(argv))
            return agent.subprocess.CompletedProcess(argv, 0)

        agent.subprocess.run = fake_run

    def tearDown(self):
        agent.subprocess.run = self._run

    def test_clear_session_ends_only_the_kiosk_browser(self):
        agent.execute_command({"action": "clear-session"})
        self.assertEqual(
            self.calls,
            [["pkill", "-f", "--", f"--user-data-dir={agent.BROWSER_PROFILE_DIR}"]],
        )

    def test_clear_session_neither_reboots_nor_deletes_files_itself(self):
        agent.execute_command({"action": "clear-session"})
        flat = [arg for call in self.calls for arg in call]
        self.assertNotIn("systemctl", flat)
        self.assertNotIn("rm", flat)

    def test_the_profile_the_agent_ends_is_the_one_the_watchdogs_wipe(self):
        # The agent relies on both launchers deleting this exact directory
        # before every relaunch; if either stops, clear-session stops clearing.
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        launchers = [
            os.path.join(CHROOT, "etc/openbox/autostart"),
            os.path.join(root, "docker-test/entrypoint.sh"),
        ]
        for path in launchers:
            with self.subTest(launcher=path):
                with open(path, encoding="utf-8") as handle:
                    script = handle.read()
                self.assertIn(f"--user-data-dir={agent.BROWSER_PROFILE_DIR}", script)
                self.assertRegex(script, r"rm -rf [^\n]*" + agent.BROWSER_PROFILE_DIR.replace("/", r"\/"))


class AdminAuthenticationAndSession(unittest.TestCase):
    def setUp(self):
        agent._admin_sessions.clear()
        agent._admin_failures["count"] = 0
        agent._admin_failures["lockedUntil"] = 0.0

    def test_unlocked_setup_mode_issues_valid_session(self):
        orig_read = agent.read_admin_password_hash
        try:
            agent.read_admin_password_hash = lambda: None
            status, payload = agent.issue_admin_session("any-pass")
            self.assertEqual(status, 200)
            self.assertTrue(payload.get("verified"))
            token = payload.get("token")
            self.assertTrue(token)
            self.assertTrue(agent.has_admin_session(token))
            self.assertFalse(agent.has_admin_session("wrong-token"))
            self.assertFalse(agent.has_admin_session(""))
        finally:
            agent.read_admin_password_hash = orig_read


class RebootEndpointGating(unittest.TestCase):
    def setUp(self):
        agent._admin_sessions.clear()
        agent._admin_failures["count"] = 0
        agent._admin_failures["lockedUntil"] = 0.0

    def _handler(self, headers=None):
        base_headers = {"Host": "127.0.0.1:8888"}
        if headers:
            base_headers.update(headers)
        handler = object.__new__(agent.LocalApiHandler)
        handler.path = "/api/reboot"
        handler.headers = FakeHeaders(base_headers)
        handler.sent_status = None
        handler.sent_payload = None
        handler._send = lambda status, payload, content_type="application/json": (
            setattr(handler, "sent_status", status),
            setattr(handler, "sent_payload", payload),
        )
        return handler

    def test_installed_workstation_refuses_unauthenticated_reboot(self):
        orig_live = agent.is_live_session
        try:
            agent.is_live_session = lambda: False
            handler = self._handler()
            handler.do_POST()
            self.assertEqual(handler.sent_status, 401)
            self.assertIn("Administrator authentication", handler.sent_payload.get("error", ""))
        finally:
            agent.is_live_session = orig_live

    def test_installed_workstation_accepts_authenticated_reboot(self):
        orig_live = agent.is_live_session
        orig_popen = agent.subprocess.Popen
        try:
            agent.is_live_session = lambda: False
            agent.subprocess.Popen = lambda *args, **kwargs: None
            agent._admin_sessions["test-valid-token"] = 9999999999.0
            handler = self._handler({agent.ADMIN_TOKEN_HEADER: "test-valid-token"})
            handler.do_POST()
            self.assertEqual(handler.sent_status, 200)
            self.assertEqual(handler.sent_payload.get("status"), "rebooting")
        finally:
            agent.is_live_session = orig_live
            agent.subprocess.Popen = orig_popen

    def test_live_workstation_allows_reboot_without_admin_token(self):
        orig_live = agent.is_live_session
        orig_popen = agent.subprocess.Popen
        try:
            agent.is_live_session = lambda: True
            agent.subprocess.Popen = lambda *args, **kwargs: None
            handler = self._handler()
            handler.do_POST()
            self.assertEqual(handler.sent_status, 200)
            self.assertEqual(handler.sent_payload.get("status"), "rebooting")
        finally:
            agent.is_live_session = orig_live
            agent.subprocess.Popen = orig_popen
class AgentLogTrimming(unittest.TestCase):
    def test_trim_agent_log_drops_head_when_exceeding_cap(self):
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w+b", delete=False) as tf:
            tf_path = tf.name
            tf.write(b"header line\n" + b"x" * (agent.LOG_TRIM_AT_BYTES + 100) + b"\nfinal line\n")
        try:
            orig_file = agent.AGENT_LOG_FILE
            agent.AGENT_LOG_FILE = tf_path
            agent.trim_agent_log()
            with open(tf_path, "rb") as f:
                content = f.read()
            self.assertIn(b"earlier entries were dropped", content)
            self.assertTrue(content.endswith(b"final line\n"))
            self.assertLessEqual(len(content), agent.LOG_KEEP_BYTES + 200)
        finally:
            agent.AGENT_LOG_FILE = orig_file
            try:
                os.unlink(tf_path)
            except OSError:
                pass


class RejectedEnrolment(unittest.TestCase):
    """A workstation whose token the control plane refuses must not be stranded.

    It used to only log it, stay on its old home page with no allowlist, and --
    after a reboot -- sit on Chromium's "This page is blocked", where the kiosk
    bar cannot appear and nothing leads back to setup.
    """

    KEYS = ("enrolmentRejected", "targetUrl", "broadcastUrl", "broadcastEpoch", "isLocked", "subdomain", "customDomain")

    def setUp(self):
        self.saved = {key: agent.state[key] for key in self.KEYS}
        self.restarts = []
        self.orig_restart = agent.restart_browser
        agent.restart_browser = lambda reason="": self.restarts.append(reason)
        agent.state.update({
            "enrolmentRejected": False, "targetUrl": "http://10.0.0.5:8787/?tenant=demo",
            "broadcastUrl": "https://example.com/", "broadcastEpoch": 7, "isLocked": True,
            "subdomain": "demo", "customDomain": "",
        })

    def tearDown(self):
        agent.restart_browser = self.orig_restart
        agent.state.update(self.saved)

    def test_the_screen_goes_to_re_enrolment_once(self):
        self.assertTrue(agent.mark_enrolment_rejected())
        self.assertFalse(agent.mark_enrolment_rejected(), "a second refusal changes nothing")
        self.assertEqual(len(self.restarts), 1, "the browser is restarted exactly once")
        self.assertTrue(agent.state["enrolmentRejected"])
        self.assertEqual(agent.state["targetUrl"], agent.REENROL_URL)
        self.assertTrue(agent.REENROL_URL.startswith("http://127.0.0.1:8888/setup"),
                        "somewhere the boot-time policy always allows")
        # Nothing from the dead organization may pull the screen away again.
        self.assertEqual((agent.state["broadcastUrl"], agent.state["broadcastEpoch"], agent.state["isLocked"]), ("", 0, False))

    def test_an_accepted_heartbeat_clears_it(self):
        agent.mark_enrolment_rejected()
        agent.clear_enrolment_rejected()
        self.assertFalse(agent.state["enrolmentRejected"])

    def test_the_heartbeat_reacts_to_a_refused_token(self):
        import inspect
        from urllib.error import HTTPError
        orig_post = agent.post_telemetry

        def refused():
            raise HTTPError("http://10.0.0.5:8787/api/telemetry", 401, "Unauthorized", {}, None)

        try:
            agent.post_telemetry = refused
            self.assertEqual(agent.http_heartbeat(), "rejected")
            self.assertEqual(agent.state["targetUrl"], agent.REENROL_URL)
            agent.post_telemetry = lambda: {"status": "ok"}
            self.assertEqual(agent.http_heartbeat(), "ok")
            self.assertFalse(agent.state["enrolmentRejected"], "an accepted heartbeat clears it")
        finally:
            agent.post_telemetry = orig_post
        # An enrolment must not wait out a minute of back-off for its allowlist.
        self.assertIn("heartbeat_wakeup.wait(wait)", inspect.getsource(agent.telemetry_loop))
        self.assertIn("heartbeat_wakeup.set()", inspect.getsource(agent.enroll))


class FakeWebSocketModule:
    """The parts of websocket-client the agent uses, so these tests need no package."""

    class WebSocketException(Exception):
        pass

    class WebSocketTimeoutException(WebSocketException):
        pass

    class WebSocketConnectionClosedException(WebSocketException):
        pass

    class WebSocketBadStatusException(WebSocketException):
        def __init__(self, status):
            super().__init__(f"Handshake status {status}")
            self.status_code = status

    class ABNF:
        OPCODE_TEXT = 1
        OPCODE_CLOSE = 8


class FakeSocket:
    def __init__(self, *incoming):
        self.incoming = list(incoming)
        self.sent = []
        self.closed = False

    def settimeout(self, seconds):
        self.timeout = seconds

    def recv_data(self):
        if not self.incoming:
            raise FakeWebSocketModule.WebSocketTimeoutException("timed out")
        return self.incoming.pop(0)

    def send(self, text):
        self.sent.append(text)

    def close(self):
        self.closed = True


def text_frame(message):
    return (FakeWebSocketModule.ABNF.OPCODE_TEXT, json.dumps(message).encode("utf-8"))


def close_frame(code, reason=""):
    return (FakeWebSocketModule.ABNF.OPCODE_CLOSE, code.to_bytes(2, "big") + reason.encode("utf-8"))


class ControlChannel(unittest.TestCase):
    """The WebSocket to the organization's hub: what it applies, what it sends, and
    how each way it can end is handled. A mistake here is a workstation that
    stops obeying its operators, or one that streams its screen to nobody."""

    PATCHED = ("websocket", "sync_chromium_policies", "execute_command", "restart_browser",
               "capture_thumbnail_base64", "current_status", "mark_enrolment_rejected", "load_proxy_config")
    KEYS = ("targetUrl", "broadcastUrl", "broadcastEpoch", "workerUrl", "deviceToken", "subdomain",
            "enrolmentRejected", "pendingBrowserRestart")

    def setUp(self):
        self.orig = {name: getattr(agent, name) for name in self.PATCHED}
        self.saved = {key: agent.state[key] for key in self.KEYS}
        self.whitelists, self.commands, self.rejections = [], [], []
        self.status = {"clientNum": 3, "activeUrl": "https://portal.example/home", "isLocked": False}
        self.now = [1000.0]
        agent.websocket = FakeWebSocketModule
        agent.sync_chromium_policies = lambda hosts, force=False: self.whitelists.append(list(hosts))
        agent.execute_command = self.commands.append
        agent.restart_browser = lambda reason="": None
        agent.capture_thumbnail_base64 = lambda: "data:image/jpeg;base64,AAAA"
        agent.current_status = lambda: dict(self.status)
        agent.mark_enrolment_rejected = lambda: self.rejections.append(True)
        agent.load_proxy_config = lambda: dict(agent.DEFAULT_PROXY_CONFIG)
        agent.state.update({"workerUrl": "https://acme.labkiosk.example", "deviceToken": "tok-123",
                            "subdomain": "acme", "broadcastEpoch": 0, "broadcastUrl": "",
                            "pendingBrowserRestart": False})
        agent.heartbeat_wakeup.clear()

    def tearDown(self):
        for name, value in self.orig.items():
            setattr(agent, name, value)
        agent.state.update(self.saved)
        agent.heartbeat_wakeup.clear()

    def channel(self, *incoming):
        ws = FakeSocket(*incoming)
        return ws, agent.ControlChannel(ws, clock=lambda: self.now[0])

    def sent(self, ws, kind):
        return [json.loads(text) for text in ws.sent if json.loads(text).get("type") == kind]

    def test_the_ping_is_exactly_the_hubs_auto_response_request(self):
        # The edge answers a byte-identical ping without waking the hub; json.dumps
        # would add a space and turn every ping into a billed request.
        with open(os.path.join(ROOT, "..", "cloudflare-control", "src", "org_hub.ts"), encoding="utf-8") as handle:
            hub = handle.read()
        self.assertIn(f"export const HUB_PING = '{agent.WEBSOCKET_PING}';", hub)
        self.assertLess(agent.WEBSOCKET_PING_SECONDS, agent.ONLINE_HEARTBEAT_WINDOW_SECONDS,
                        "a pong must arrive inside the window that counts the workstation online")

    def test_the_address_follows_the_worker_scheme(self):
        self.assertEqual(agent.websocket_url("https://acme.labkiosk.example"), "wss://acme.labkiosk.example/api/devices/ws")
        self.assertEqual(agent.websocket_url("http://10.0.0.5:8787"), "ws://10.0.0.5:8787/api/devices/ws")

    def test_config_and_commands_are_applied(self):
        ws, channel = self.channel()
        channel.handle(json.dumps({"type": "config", "whitelist": ["docs.example"],
                                   "broadcastUrl": "https://docs.example/", "broadcastEpoch": 42,
                                   "targetUrl": "https://docs.example/", "commands": [{"action": "lock"}]}))
        channel.handle(json.dumps({"type": "commands", "commands": [{"action": "reload"}, "junk"]}))
        self.assertEqual(self.whitelists, [["docs.example"]])
        self.assertEqual(agent.state["targetUrl"], "https://docs.example/")
        self.assertEqual((agent.state["broadcastEpoch"], agent.state["broadcastUrl"]), (42, "https://docs.example/"))
        self.assertEqual(self.commands, [{"action": "lock"}, {"action": "reload"}], "only objects are commands")

    def test_a_new_target_is_in_place_before_the_policy_is_written(self):
        # The policy allows the target's host; written before a change of target
        # (a renamed subdomain), it would block the very page the kiosk moves to.
        seen = []
        agent.sync_chromium_policies = lambda hosts, force=False: seen.append((agent.state["targetUrl"], force))
        agent.state["targetUrl"] = "https://old-name.labkiosk.example/"
        agent.apply_control_update({"whitelist": ["docs.example"], "targetUrl": "https://new-name.labkiosk.example/"})
        self.assertEqual(seen, [("https://new-name.labkiosk.example/", True)], "rewritten even if the allowlist is unchanged")
        agent.apply_control_update({"whitelist": ["docs.example"], "targetUrl": "https://new-name.labkiosk.example/"})
        self.assertEqual(seen[-1], ("https://new-name.labkiosk.example/", False), "an unchanged target forces nothing")

    def test_a_new_target_without_an_allowlist_still_rewrites_the_policy(self):
        calls = []
        agent.sync_chromium_policies = lambda hosts, force=False: calls.append((list(hosts), force))
        orig_cached = agent.cached_whitelist
        try:
            agent.cached_whitelist = ["docs.example"]
            agent.state["targetUrl"] = "https://old-name.labkiosk.example/"
            agent.apply_control_update({"targetUrl": "https://new-name.labkiosk.example/"})
            self.assertEqual(calls, [(["docs.example"], True)], "the allowlist it has, for the new home page")
            agent.apply_control_update({"commands": []})
            self.assertEqual(len(calls), 1, "an update with no new target writes nothing")
        finally:
            agent.cached_whitelist = orig_cached

    def test_a_malformed_message_changes_nothing(self):
        ws, channel = self.channel()
        for text in ("not json", "[1, 2]", json.dumps({"type": "config", "broadcastEpoch": "soon"})):
            channel.handle(text)
        self.assertEqual(agent.state["broadcastEpoch"], 0)
        self.assertEqual(self.commands, [])

    def test_status_is_sent_on_connect_and_then_only_when_it_changes(self):
        ws, channel = self.channel()
        channel.tick()
        self.now[0] += 1.5
        channel.tick()
        self.assertEqual(len(self.sent(ws, "status")), 1)
        self.status["isLocked"] = True
        self.now[0] += 1.5
        channel.tick()
        statuses = self.sent(ws, "status")
        self.assertEqual(len(statuses), 2)
        self.assertTrue(statuses[-1]["isLocked"])
        self.assertNotIn("thumbnail", statuses[-1], "a status never carries the screen")

    def test_it_pings_and_gives_up_on_silence(self):
        ws, channel = self.channel()
        self.now[0] += agent.WEBSOCKET_PING_SECONDS
        self.assertIsNone(channel.tick())
        self.assertIn(agent.WEBSOCKET_PING, ws.sent)
        self.now[0] += agent.WEBSOCKET_SILENCE_SECONDS
        self.assertEqual(channel.tick(), agent.SESSION_ENDED)

    def test_a_pong_keeps_the_workstation_online(self):
        ws, channel = self.channel(text_frame({"type": "pong"}))
        agent.state["lastHeartbeatOk"] = 0.0
        self.now[0] += 30
        self.assertIsNone(channel.receive())
        self.assertGreater(agent.state["lastHeartbeatOk"], 0.0)
        self.assertEqual(channel.last_heard, self.now[0])

    def test_frames_are_sent_only_while_someone_watches(self):
        ws, channel = self.channel()
        channel.tick()
        self.assertEqual(self.sent(ws, "frame"), [], "nobody is watching yet")
        channel.handle(json.dumps({"type": "frames", "on": True, "intervalSeconds": 3}))
        channel.tick()
        self.now[0] += 1
        channel.tick()
        self.assertEqual(len(self.sent(ws, "frame")), 1, "one frame per interval")
        self.now[0] += 2
        channel.tick()
        self.assertEqual(len(self.sent(ws, "frame")), 2)
        channel.handle(json.dumps({"type": "frames", "on": False}))
        self.now[0] += 10
        channel.tick()
        self.assertEqual(len(self.sent(ws, "frame")), 2)

    def test_the_frame_interval_is_bounded(self):
        ws, channel = self.channel()
        channel.handle(json.dumps({"type": "frames", "on": True, "intervalSeconds": 0}))
        self.assertEqual(channel.frame_interval, agent.FRAME_INTERVAL_BOUNDS[0])
        channel.handle(json.dumps({"type": "frames", "on": True, "intervalSeconds": 10 ** 9}))
        self.assertEqual(channel.frame_interval, agent.FRAME_INTERVAL_BOUNDS[1])

    def test_each_close_code_is_handled(self):
        cases = (
            (agent.WS_CLOSE_REMOVED, agent.SESSION_REJECTED, 1),
            (agent.WS_CLOSE_INACTIVE, agent.SESSION_REJECTED, 1),
            (agent.WS_CLOSE_REPLACED, agent.SESSION_FAILED, 0),
            (agent.WS_CLOSE_STALE, agent.SESSION_ENDED, 0),
            (1001, agent.SESSION_ENDED, 0),
        )
        for code, outcome, rejections in cases:
            with self.subTest(code=code):
                self.rejections.clear()
                ws, channel = self.channel(close_frame(code, "bye"))
                self.assertEqual(channel.run(), outcome)
                self.assertEqual(len(self.rejections), rejections)

    def test_a_new_enrolment_reconnects(self):
        ws, channel = self.channel()
        agent.heartbeat_wakeup.set()
        self.assertEqual(channel.run(), agent.SESSION_ENDED)
        self.assertFalse(agent.heartbeat_wakeup.is_set())

    def test_the_handshake_outcomes(self):
        cases = ((401, agent.SESSION_REJECTED, 1), (403, agent.SESSION_REJECTED, 1),
                 (426, agent.SESSION_UNSUPPORTED, 0), (404, agent.SESSION_UNSUPPORTED, 0),
                 (501, agent.SESSION_UNSUPPORTED, 0), (502, agent.SESSION_FAILED, 0))
        for status, outcome, rejections in cases:
            with self.subTest(status=status):
                self.rejections.clear()

                def refuse(*args, **kwargs):
                    raise FakeWebSocketModule.WebSocketBadStatusException(status)

                FakeWebSocketModule.create_connection = staticmethod(refuse)
                self.assertEqual(agent.open_control_channel(), (None, outcome))
                self.assertEqual(len(self.rejections), rejections)

        def unreachable(*args, **kwargs):
            raise ConnectionRefusedError("refused")

        FakeWebSocketModule.create_connection = staticmethod(unreachable)
        self.assertEqual(agent.open_control_channel(), (None, agent.SESSION_FAILED))

    def test_the_handshake_carries_the_token_and_the_proxy(self):
        calls = []
        FakeWebSocketModule.create_connection = staticmethod(lambda url, **kwargs: calls.append((url, kwargs)) or FakeSocket())
        agent.load_proxy_config = lambda: {"enabled": True, "host": "proxy.acme.example", "port": 3128, "bypass": "intranet.example"}
        ws, outcome = agent.open_control_channel()
        self.assertIsNone(outcome)
        url, options = calls[0]
        self.assertEqual(url, "wss://acme.labkiosk.example/api/devices/ws")
        self.assertIn("Authorization: Bearer tok-123", options["header"])
        self.assertTrue(options["suppress_origin"], "a workstation is not a browser page")
        self.assertEqual((options["http_proxy_host"], options["http_proxy_port"]), ("proxy.acme.example", 3128))
        self.assertIn("127.0.0.1", options["http_no_proxy"])
        self.assertIn("intranet.example", options["http_no_proxy"])


class BootPolicyBeforeTheBrowser(unittest.TestCase):
    """After a reboot the policy is the boot-time one (loopback only), and the
    launcher opens the home page as soon as the local API answers. An enrolled
    agent must allow its own server and home page before that API exists, or
    the home page is blocked until the control plane is reachable."""

    PATCHED = ("apply_proxy_to_environment", "apply_saved_localization", "load_config",
               "sync_chromium_policies", "telemetry_loop", "log")

    def setUp(self):
        self.orig = {name: getattr(agent, name) for name in self.PATCHED}
        self.orig_thread = agent.threading.Thread
        self.orig_configured = agent.state["isConfigured"]
        self.events = []
        agent.apply_proxy_to_environment = lambda cfg: None
        agent.apply_saved_localization = lambda: None
        agent.load_config = lambda: None
        agent.log = lambda message: None
        agent.sync_chromium_policies = lambda hosts, force=False: self.events.append(("sync", list(hosts), force))

        events = self.events

        class RecordingThread:
            def __init__(self, target=None, daemon=None):
                self.target = target

            def start(self):
                events.append(("thread", self.target.__name__))

        agent.threading.Thread = RecordingThread

        def stop():
            raise KeyboardInterrupt

        agent.telemetry_loop = stop

    def tearDown(self):
        for name, value in self.orig.items():
            setattr(agent, name, value)
        agent.threading.Thread = self.orig_thread
        agent.state["isConfigured"] = self.orig_configured

    def run_main(self):
        with self.assertRaises(SystemExit):
            agent.main()

    def test_an_enrolled_agent_writes_the_policy_before_its_api_answers(self):
        agent.state["isConfigured"] = True
        self.run_main()
        self.assertEqual(self.events, [("sync", [], True), ("thread", "start_local_server"),
                                       ("thread", "boot_report_loop")])

    def test_an_unenrolled_agent_has_nothing_to_allow_yet(self):
        agent.state["isConfigured"] = False
        self.run_main()
        self.assertEqual(self.events, [("thread", "start_local_server"), ("thread", "boot_report_loop")])


class ReenrolmentGating(unittest.TestCase):
    """Registering an enrolled workstation again replaces its enrolment, so it takes
    the administrator password on an installed workstation -- and is possible at
    all, where it used to be refused outright with 409."""

    def setUp(self):
        agent._admin_sessions.clear()
        self.orig_live = agent.is_live_session
        self.orig_configured = agent.state["isConfigured"]

    def tearDown(self):
        agent.is_live_session = self.orig_live
        agent.state["isConfigured"] = self.orig_configured
        agent._admin_sessions.clear()

    def post_setup(self, live, configured, token=None):
        agent.is_live_session = lambda: live
        agent.state["isConfigured"] = configured
        headers = {"Host": "127.0.0.1:8888"}
        if token:
            headers[agent.ADMIN_TOKEN_HEADER] = token
        handler = object.__new__(agent.LocalApiHandler)
        handler.path = "/api/setup"
        handler.headers = FakeHeaders(headers)
        handler.sent = None
        handler._send = lambda status, payload, content_type="application/json": setattr(handler, "sent", (status, payload))
        handler.do_POST()
        return handler.sent

    def test_an_enrolled_installed_workstation_needs_the_password(self):
        status, payload = self.post_setup(live=False, configured=True)
        self.assertEqual(status, 401)
        self.assertIn("Administrator authentication", payload["error"])

    def test_with_the_password_it_may_register_again(self):
        agent._admin_sessions["valid"] = 9999999999.0
        status, payload = self.post_setup(live=False, configured=True, token="valid")
        # Past the gate: what is refused now is the empty request itself.
        self.assertEqual((status, payload.get("error")), (400, "A JSON body is required"))

    def test_first_enrolment_and_live_media_are_unchanged(self):
        self.assertEqual(self.post_setup(live=False, configured=False)[0], 400)
        self.assertEqual(self.post_setup(live=True, configured=True)[0], 400)


class NoPageWithoutTheBar(unittest.TestCase):
    """Chromium's block and network-error pages are chrome-error://, where no
    extension runs; the extension sends those failures to pages that have the bar."""

    def read(self, rel):
        with open(os.path.join(CHROOT, rel), encoding="utf-8") as handle:
            return handle.read()

    def test_the_extension_may_see_navigation_errors(self):
        import json
        manifest = json.loads(self.read("opt/labkiosk/extension/manifest.json"))
        self.assertIn("webNavigation", manifest["permissions"])

    def test_only_top_level_failures_away_from_the_agent_are_redirected(self):
        source = self.read("opt/labkiosk/extension/background.js")
        self.assertIn("chrome.webNavigation.onErrorOccurred.addListener", source)
        self.assertIn("details.frameId !== 0", source)
        self.assertIn("failed.origin === AGENT_ORIGIN", source, "a failure on the agent's own page must not loop")
        self.assertIn('"net::ERR_BLOCKED_BY_ADMINISTRATOR"', source)
        self.assertIn("${BLOCKED_PAGE_URL}?host=", source)

    def test_a_failure_from_before_the_extension_started_is_recovered(self):
        # The first page after a reboot fails while Chromium is still starting,
        # before the service worker listens; onErrorOccurred never sees it.
        source = self.read("opt/labkiosk/extension/background.js")
        self.assertIn("async function recoverMissedErrors()", source)
        self.assertIn("chrome.webNavigation.getAllFrames", source)
        self.assertIn("top.errorOccurred", source)
        loop = source.split("async function recoverMissedErrors()", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("await recoverTab(tab.id);", loop)
        self.assertIn("} catch (err) {", loop, "a tab that closes meanwhile must not stop the others' recovery")
        body = source.split("async function recoverTab(tabId)", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("failed.origin === AGENT_ORIGIN", body, "recovery pages are never redirected")
        self.assertIn('["http:", "https:"]', body)
        self.assertIn("\nrecoverMissedErrors().catch(", source, "it runs whenever the worker starts")

    def test_the_blocked_page_is_safe_markup(self):
        import re
        page = self.read("opt/labkiosk/setup/blocked.html")
        self.assertIsNone(re.search(r"<[a-z][^>]*\son[a-z]+=", page, re.I), "no inline event handlers")
        self.assertNotIn("innerHTML", page, "the blocked host is attacker-chosen: textContent only")
        # The retry navigates to an address from the query string: http(s) only,
        # and once, so a site that really is blocked cannot loop.
        self.assertIn("parsed.protocol === 'http:' || parsed.protocol === 'https:'", page)
        self.assertIn("sessionStorage.getItem(marker) === '1'", page)

    def test_the_agent_serves_it(self):
        orig = agent.BLOCKED_HTML_FILE
        agent.BLOCKED_HTML_FILE = os.path.join(CHROOT, "opt/labkiosk/setup/blocked.html")
        try:
            handler = object.__new__(agent.LocalApiHandler)
            handler.path = "/blocked?host=example.com"
            handler.headers = FakeHeaders({"Host": "127.0.0.1:8888"})
            handler.sent = None
            handler._send = lambda status, payload, content_type="application/json": setattr(handler, "sent", (status, content_type))
            handler.do_GET()
            self.assertEqual(handler.sent, (200, "text/html; charset=utf-8"))
        finally:
            agent.BLOCKED_HTML_FILE = orig


class BootEnvironment(unittest.TestCase):
    """grubenv: the four values GRUB reads to choose a system image."""

    def test_a_block_is_exactly_one_kibibyte_and_reads_back(self):
        values = {"current": "2.6.0", "previous": "2.5.1", "next": "2.6.1", "next_tries": "1"}
        data = bootslots.render_env(values)
        self.assertEqual(len(data), 1024)
        self.assertTrue(data.startswith(b"# GRUB Environment Block\n"))
        self.assertEqual(bootslots.parse_env(data), values)

    def test_nothing_grub_would_have_to_escape_is_written(self):
        for bad in ({"current": "2.6.0\nnext=9.9.9"}, {"current": "../../etc"},
                    {"next_tries": "2"}, {"current": "2.6.0", "timeout": "0"}):
            with self.subTest(values=bad):
                with self.assertRaises(ValueError):
                    bootslots.render_env(bad)

    def test_a_damaged_block_is_refused(self):
        with self.assertRaises(ValueError):
            bootslots.parse_env(b"# GRUB Environment Block\ncurrent=2.6.0\n")
        with self.assertRaises(ValueError):
            bootslots.parse_env(b"x" * 1024)

    def test_the_file_is_replaced_whole(self):
        with tempfile.TemporaryDirectory() as boot_dir:
            bootslots.write_env(boot_dir, {"current": "2.6.0"})
            bootslots.write_env(boot_dir, {"current": "2.6.0", "next": "2.6.1", "next_tries": "1"})
            self.assertEqual(sorted(os.listdir(boot_dir)), ["grubenv"])
            self.assertEqual(bootslots.read_env(boot_dir)["next"], "2.6.1")
            self.assertEqual(os.stat(os.path.join(boot_dir, "grubenv")).st_size, 1024)

    def test_the_installer_starts_with_one_current_image(self):
        with tempfile.TemporaryDirectory() as boot_dir:
            self.assertEqual(bootslots.cmd_init("2.6.0", boot_dir), {"current": "2.6.0"})
            self.assertEqual(bootslots.read_env(boot_dir), {"current": "2.6.0"})


class BootSelection(unittest.TestCase):
    """What a boot was, and what confirming it changes."""

    def test_each_kind_of_boot(self):
        cases = [
            ({"current": "2.6.0"}, "2.6.0", "running"),
            ({"current": "2.6.0", "next": "2.6.1", "next_tries": "1"}, "2.6.0", "staged"),
            ({"current": "2.6.0", "next": "2.6.1", "next_tries": "0"}, "2.6.1", "trial"),
            ({"current": "2.6.0", "next": "2.6.1", "next_tries": "0"}, "2.6.0", "rolled-back"),
            ({"current": "2.6.0", "previous": "2.5.1"}, "2.5.1", "fallback"),
        ]
        for env, running, expected in cases:
            with self.subTest(env=env, running=running):
                self.assertEqual(bootslots.classify(env, running), expected)

    def test_a_confirmed_image_becomes_current_and_the_old_one_previous(self):
        env = {"current": "2.6.0", "previous": "2.5.1", "next": "2.6.1", "next_tries": "0"}
        self.assertEqual(bootslots.promote(env), {"current": "2.6.1", "previous": "2.6.0"})

    def test_the_running_image_comes_from_the_command_line(self):
        args = ["boot=live", "live-media-path=/images/2.6.1", "labkiosk.installed=1"]
        self.assertTrue(bootslots.is_installed(args))
        self.assertEqual(bootslots.running_version(args), "2.6.1")
        self.assertFalse(bootslots.is_installed(["boot=live", "labkiosk.installed=10"]))

    def test_a_media_path_outside_the_image_store_is_refused(self):
        for bad in ("live-media-path=/live", "live-media-path=/images/../etc",
                    "live-media-path=/images/2.6.1/x"):
            with self.subTest(arg=bad):
                with self.assertRaises(RuntimeError):
                    bootslots.running_version([bad])

    def test_only_a_complete_image_can_be_booted(self):
        with tempfile.TemporaryDirectory() as root:
            for version, files in (("2.6.0", bootslots.IMAGE_FILES), ("2.6.1", ("vmlinuz",))):
                folder = os.path.join(root, "images", version)
                os.makedirs(folder)
                for name in files:
                    open(os.path.join(folder, name), "w").close()
            os.makedirs(os.path.join(root, "images", "not-a-version"))
            self.assertTrue(bootslots.has_image(root, "2.6.0"))
            self.assertFalse(bootslots.has_image(root, "2.6.1"))
            self.assertFalse(bootslots.has_image(root, "../2.6.0"))
            self.assertEqual(bootslots.complete_images(root), ["2.6.0"])

    def test_no_image_store_means_no_images(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(bootslots.complete_images(root), [])
            open(os.path.join(root, "images"), "w").close()
            self.assertEqual(bootslots.complete_images(root), [])


class BootHealthCheck(unittest.TestCase):
    """The one try passes only if the kiosk stays up, without a gap, for the hold."""

    def run_check(self, healthy_at):
        now = [0.0]
        return bootslots.wait_until_healthy(
            lambda: healthy_at(now[0]), clock=lambda: now[0],
            sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
            hold=60, deadline=600, poll=5)

    def test_a_kiosk_that_comes_up_and_stays_up_passes(self):
        self.assertTrue(self.run_check(lambda t: t >= 120))

    def test_a_kiosk_that_never_comes_up_fails_at_the_deadline(self):
        self.assertFalse(self.run_check(lambda t: False))

    def test_a_kiosk_that_keeps_falling_over_fails(self):
        self.assertFalse(self.run_check(lambda t: int(t) % 50 < 40))

    def test_the_browser_is_recognised_by_its_profile(self):
        with tempfile.TemporaryDirectory() as proc:
            os.makedirs(os.path.join(proc, "100"))
            with open(os.path.join(proc, "100", "cmdline"), "wb") as handle:
                handle.write(b"/usr/lib/chromium/chromium\0--kiosk\0--user-data-dir=/tmp/other\0")
            self.assertFalse(bootslots.browser_running(proc))
            os.makedirs(os.path.join(proc, "101"))
            with open(os.path.join(proc, "101", "cmdline"), "wb") as handle:
                handle.write(b"/usr/lib/chromium/chromium\0--kiosk\0"
                             + bootslots.BROWSER_PROFILE_ARG.encode() + b"\0")
            self.assertTrue(bootslots.browser_running(proc))

    def test_the_health_check_looks_for_the_browser_the_launchers_start(self):
        self.assertEqual(bootslots.BROWSER_PROFILE_ARG, f"--user-data-dir={agent.BROWSER_PROFILE_DIR}")


    def test_the_agent_check_never_goes_through_a_proxy(self):
        import http.server
        import threading

        class Status(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Status)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        saved_url = bootslots.AGENT_STATUS_URL
        saved_env = {k: os.environ.get(k) for k in ("http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY")}
        try:
            bootslots.AGENT_STATUS_URL = f"http://127.0.0.1:{server.server_port}/api/status"
            for key in saved_env:
                os.environ.pop(key, None)
            os.environ["http_proxy"] = os.environ["HTTP_PROXY"] = "http://127.0.0.1:9/"
            self.assertTrue(bootslots.agent_answers())
        finally:
            bootslots.AGENT_STATUS_URL = saved_url
            for key, value in saved_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            server.shutdown()
            server.server_close()

class InstalledBootMenu(unittest.TestCase):
    """The grub.cfg every installed disk boots through."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(CHROOT, "usr/share/labkiosk/boot/grub.cfg"), encoding="utf-8") as handle:
            cls.cfg = handle.read()
        cls.entries = [line for line in cls.cfg.splitlines() if line.strip().startswith("menuentry ")]
        cls.kernels = [line.strip() for line in cls.cfg.splitlines() if line.strip().startswith("linux ")]

    def test_every_entry_boots_without_a_password(self):
        self.assertTrue(self.entries)
        for line in self.entries:
            with self.subTest(entry=line):
                self.assertIn("--unrestricted", line)

    def test_the_try_is_spent_before_the_new_image_boots(self):
        self.assertIn('if save_env --file "$prefix/grubenv" next_tries; then', self.cfg)
        self.assertLess(self.cfg.index("save_env"), self.cfg.index('set slot="$next"'))

    def test_the_command_line_marks_an_installed_disk_and_never_waits(self):
        self.assertEqual(len(self.kernels), 2)
        for line in self.kernels:
            with self.subTest(line=line):
                args = line.split()
                for required in ("boot=live", "labkiosk.installed=1", "noeject", "panic=10",
                                 "overlayroot=tmpfs:recurse=0", "username=kiosk"):
                    self.assertIn(required, args)
                # The organization's zone comes from localization.json; one here
                # would be re-applied by live-config at every boot.
                self.assertFalse([a for a in args if a.startswith("timezone=")])

    def test_the_password_file_name_is_the_one_the_agent_reads(self):
        self.assertIn(installer.GRUB_PASSWORD_FILE_NAME, self.cfg)
        self.assertEqual(os.path.basename(agent.GRUB_PASSWORD_FILE), installer.GRUB_PASSWORD_FILE_NAME)

    def test_the_installed_marker_is_one_spelling_everywhere(self):
        self.assertEqual(installer.INSTALLED_ARG, bootslots.INSTALLED_ARG)
        self.assertEqual(agent.INSTALLED_KERNEL_ARG, bootslots.INSTALLED_ARG)

    def test_the_installer_and_the_boot_tool_agree_on_versions_and_files(self):
        self.assertEqual(installer.IMAGE_VERSION_PATTERN.pattern, bootslots.VERSION_PATTERN.pattern)
        self.assertEqual(installer.IMAGE_FILES, bootslots.IMAGE_FILES)


class ImageVersion(unittest.TestCase):
    def test_the_image_version_is_the_release_version(self):
        with open(os.path.join(CHROOT, "usr/share/labkiosk/version"), encoding="utf-8") as handle:
            version = handle.read().strip()
        with open(os.path.join(CHROOT, "opt/labkiosk/extension/manifest.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        self.assertRegex(version, bootslots.VERSION_PATTERN)
        self.assertEqual(version, agent.AGENT_VERSION)
        self.assertEqual(version, manifest["version"])


class InstalledOrLive(unittest.TestCase):
    """Both boot through live-boot now; only the installed menu says installed."""

    def setUp(self):
        self.orig_cmdline = agent.kernel_cmdline
        self.orig_exists = agent.os.path.exists

    def tearDown(self):
        agent.kernel_cmdline = self.orig_cmdline
        agent.os.path.exists = self.orig_exists

    def boot(self, cmdline):
        agent.kernel_cmdline = lambda: cmdline
        agent.os.path.exists = lambda path: path == "/run/live" or self.orig_exists(path) and path != "/etc/labkiosk-installed"

    def test_the_iso_is_live(self):
        self.boot("boot=live components username=kiosk\n")
        self.assertTrue(agent.is_live_session())

    def test_an_installed_disk_is_not_live_though_it_boots_through_live_boot(self):
        self.boot("boot=live components live-media-path=/images/2.6.0 labkiosk.installed=1 noeject\n")
        self.assertFalse(agent.is_live_session())

    def test_a_lookalike_argument_is_not_the_marker(self):
        self.boot("boot=live labkiosk.installed=10\n")
        self.assertTrue(agent.is_live_session())


class AdministratorPasswordFile(unittest.TestCase):
    """The digest lives on the boot partition; an unreadable one never opens the gate."""

    def setUp(self):
        self.orig = (agent.GRUB_PASSWORD_FILE, agent.GRUB_CONFIG_FILE, agent.is_live_session)
        self.dir = tempfile.TemporaryDirectory()
        agent.GRUB_PASSWORD_FILE = os.path.join(self.dir.name, "labkiosk-password.cfg")
        agent.GRUB_CONFIG_FILE = os.path.join(self.dir.name, "grub.cfg")
        agent.is_live_session = lambda: False

    def tearDown(self):
        agent.GRUB_PASSWORD_FILE, agent.GRUB_CONFIG_FILE, agent.is_live_session = self.orig
        self.dir.cleanup()

    def test_the_installed_digest_is_read(self):
        digest = "grub.pbkdf2.sha512.10000." + "A" * 128 + "." + "B" * 128
        with tempfile.TemporaryDirectory() as grub_dir:
            installer.write_grub_password(grub_dir, digest)
            agent.GRUB_PASSWORD_FILE = os.path.join(grub_dir, installer.GRUB_PASSWORD_FILE_NAME)
            self.assertEqual(agent.read_admin_password_hash(), digest)

    def test_an_installation_without_a_password_is_unlocked(self):
        open(agent.GRUB_CONFIG_FILE, "w").close()
        self.assertIsNone(agent.read_admin_password_hash())

    def test_an_unreadable_boot_partition_keeps_the_gate_shut(self):
        with self.assertRaises(ValueError):
            agent.read_admin_password_hash()
        status, _ = agent.issue_admin_session("anything")
        self.assertNotEqual(status, 200)


class LiveConfigNeverGrantsRoot(unittest.TestCase):
    """live-config runs on installed disks too now; its sudo and polkit grants must not."""

    def test_the_root_granting_components_are_pre_seeded(self):
        with open(os.path.join(ROOT, "config/hooks/live/01-lockdown.hook.chroot"), encoding="utf-8") as handle:
            hook = handle.read()
        for component in ("sudo", "policykit"):
            with self.subTest(component=component):
                self.assertIn(f"touch /var/lib/live/config/{component}\n", hook)


class DataPartitionPinnedByUuid(unittest.TestCase):
    """/etc/labkiosk comes from this disk's data partition, never from a USB stick with its label."""

    GENERATOR = os.path.join(CHROOT, "etc/systemd/system-generators/labkiosk-data-generator")
    UUID = "0f3c2a51-7d4e-4b8a-9c1d-2e5f6a7b8c9d"

    def generate(self, cmdline):
        import subprocess
        with open(self.GENERATOR, encoding="utf-8") as handle:
            script = handle.read()
        self.assertEqual(script.count("CMDLINE_FILE=/proc/cmdline\n"), 1)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cmdline_file = os.path.join(tmp.name, "cmdline")
        with open(cmdline_file, "w", encoding="utf-8") as handle:
            handle.write(cmdline + "\n")
        copy = os.path.join(tmp.name, "generator")
        with open(copy, "w", encoding="utf-8") as handle:
            handle.write(script.replace("CMDLINE_FILE=/proc/cmdline\n", f"CMDLINE_FILE={cmdline_file}\n"))
        out = os.path.join(tmp.name, "out")
        os.makedirs(out)
        result = subprocess.run(["sh", copy, out, out, out], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return out

    def test_the_installed_uuid_is_mounted(self):
        out = self.generate(f"boot=live labkiosk.installed=1 labkiosk.data={self.UUID} noeject")
        with open(os.path.join(out, "etc-labkiosk.mount"), encoding="utf-8") as handle:
            unit = handle.read()
        self.assertIn(f"What=/dev/disk/by-uuid/{self.UUID}\n", unit)
        self.assertIn("Where=/etc/labkiosk\n", unit)
        self.assertIn("nofail", unit)
        self.assertEqual(os.readlink(os.path.join(out, "local-fs.target.wants", "etc-labkiosk.mount")),
                         "../etc-labkiosk.mount")

    def test_no_valid_uuid_mounts_nothing(self):
        for value in ("", "LABKIOSK_DATA", "../../sda4", self.UUID.upper(), self.UUID + "0"):
            with self.subTest(value=value):
                out = self.generate(f"boot=live labkiosk.installed=1 labkiosk.data={value}")
                self.assertEqual(os.listdir(out), [])

    def test_a_live_session_mounts_nothing(self):
        out = self.generate(f"boot=live components labkiosk.data={self.UUID}")
        self.assertEqual(os.listdir(out), [])

    def test_nothing_mounts_the_data_partition_by_label(self):
        paths = (
            os.path.join(ROOT, "config/hooks/live/01-lockdown.hook.chroot"),
            os.path.join(CHROOT, "usr/share/labkiosk/boot/grub.cfg"),
            self.GENERATOR,
        )
        for path in paths:
            with self.subTest(path=path), open(path, encoding="utf-8") as handle:
                text = handle.read()
                self.assertNotIn("by-label/LABKIOSK_DATA", text)
                # A static unit in /etc/systemd/system would override the generated one.
                self.assertNotIn("/etc/systemd/system/etc-labkiosk.mount", text)

    def test_every_installed_command_line_carries_the_uuid(self):
        with open(os.path.join(CHROOT, "usr/share/labkiosk/boot/grub.cfg"), encoding="utf-8") as handle:
            cfg = handle.read()
        self.assertIn(installer.DATA_ID_FILE_NAME, cfg)
        kernels = [line.split() for line in cfg.splitlines() if line.strip().startswith("linux ")]
        self.assertTrue(kernels)
        for args in kernels:
            self.assertIn("labkiosk.data=$data_uuid", args)

    def test_the_installer_records_the_uuid_for_grub(self):
        orig = installer.run_cmd
        self.addCleanup(setattr, installer, "run_cmd", orig)
        with tempfile.TemporaryDirectory() as grub_dir:
            installer.run_cmd = lambda cmd, check=True: self.UUID
            installer.write_data_partition_id(grub_dir, "/dev/sda4")
            with open(os.path.join(grub_dir, installer.DATA_ID_FILE_NAME), encoding="utf-8") as handle:
                self.assertEqual(handle.read(), f'set data_uuid="{self.UUID}"\n')

    def test_the_installer_refuses_a_missing_uuid(self):
        orig = installer.run_cmd
        self.addCleanup(setattr, installer, "run_cmd", orig)
        with tempfile.TemporaryDirectory() as grub_dir:
            for answer in ("", 'x"; set superusers=""'):
                with self.subTest(answer=answer):
                    installer.run_cmd = lambda cmd, check=True, answer=answer: answer
                    with self.assertRaises(RuntimeError):
                        installer.write_data_partition_id(grub_dir, "/dev/sda4")
                    self.assertFalse(os.path.exists(os.path.join(grub_dir, installer.DATA_ID_FILE_NAME)))


class SeedingNeverFollowsLinks(unittest.TestCase):
    """The installer copies kiosk-owned /etc/labkiosk as root; a planted link must not leak root's files."""

    def test_a_regular_file_is_copied_with_its_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dest = os.path.join(tmp, "config.json"), os.path.join(tmp, "out.json")
            with open(src, "w", encoding="utf-8") as handle:
                handle.write("{}")
            os.chmod(src, 0o600)
            self.assertTrue(installer.copy_regular_file(src, dest))
            with open(dest, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "{}")
            self.assertEqual(os.stat(dest).st_mode & 0o777, 0o600)

    def test_setuid_setgid_and_sticky_bits_are_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dest = os.path.join(tmp, "tool"), os.path.join(tmp, "out")
            with open(src, "w", encoding="utf-8") as handle:
                handle.write("#!/bin/sh\n")
            os.chmod(src, 0o7755)
            self.assertTrue(installer.copy_regular_file(src, dest))
            self.assertEqual(stat.S_IMODE(os.stat(dest).st_mode), 0o755)

    def test_a_symbolic_link_is_not_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            secret = os.path.join(tmp, "shadow")
            with open(secret, "w", encoding="utf-8") as handle:
                handle.write("root:secret")
            link, dest = os.path.join(tmp, "x"), os.path.join(tmp, "out")
            os.symlink(secret, link)
            self.assertFalse(installer.copy_regular_file(link, dest))
            self.assertFalse(os.path.exists(dest))

    def test_a_directory_is_skipped(self):
        # /etc/labkiosk holds system-connections/ beside the enrolment files.
        with tempfile.TemporaryDirectory() as tmp:
            folder, dest = os.path.join(tmp, "system-connections"), os.path.join(tmp, "out")
            os.mkdir(folder)
            self.assertFalse(installer.copy_regular_file(folder, dest))
            self.assertFalse(os.path.exists(dest))

    def test_a_fifo_is_skipped_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            fifo, dest = os.path.join(tmp, "fifo"), os.path.join(tmp, "out")
            os.mkfifo(fifo)
            self.assertFalse(installer.copy_regular_file(fifo, dest))
            self.assertFalse(os.path.exists(dest))


class BootOutcomeReporting(unittest.TestCase):
    """The agent sends what labkiosk-boot-slots recorded to the organization's console."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "status.json")
        self.saved = {name: getattr(agent, name) for name in ("read_boot_report", "post_boot_report")}
        self.saved_state = dict(agent.state)
        agent.state["isConfigured"] = True
        self.sent = []
        self.answer = 200
        agent.read_boot_report = lambda: self.saved["read_boot_report"](self.path, owner_uid=os.getuid())

        def post(report):
            self.sent.append(report)
            if isinstance(self.answer, Exception):
                raise self.answer
            return self.answer

        agent.post_boot_report = post

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(agent, name, value)
        agent.state.clear()
        agent.state.update(self.saved_state)
        self.tmp.cleanup()

    def write(self, payload):
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write(payload if isinstance(payload, str) else json.dumps(payload))

    def test_a_rollback_is_sent_once(self):
        self.write({"state": "rolled-back", "version": "2.6.0", "failed": "2.6.1", "at": 1000})
        settled = agent.report_boot_outcome(None)
        settled = agent.report_boot_outcome(settled)
        self.assertEqual(self.sent, [{"state": "rolled-back", "at": 1000, "version": "2.6.0", "failed": "2.6.1"}])

    def test_a_routine_boot_or_a_check_in_progress_sends_nothing(self):
        for state in ("running", "staged", "finishing"):
            self.write({"state": state, "version": "2.6.0", "at": 1000})
            self.assertIsNone(agent.report_boot_outcome(None))
        os.remove(self.path)
        self.assertIsNone(agent.report_boot_outcome(None))
        self.assertEqual(self.sent, [])

    def test_an_unenrolled_workstation_sends_nothing(self):
        agent.state["isConfigured"] = False
        self.write({"state": "error", "version": "2.6.0", "error": "x", "at": 1000})
        agent.report_boot_outcome(None)
        self.assertEqual(self.sent, [])

    def test_the_outcome_after_the_health_check_is_sent_too(self):
        self.write({"state": "finishing", "version": "2.6.1", "previous": "2.6.0", "at": 1000})
        settled = agent.report_boot_outcome(None)
        self.write({"state": "installed", "version": "2.6.1", "previous": "2.6.0", "at": 1070})
        settled = agent.report_boot_outcome(settled)
        self.assertEqual([r["state"] for r in self.sent], ["installed"])
        self.assertEqual(settled, ("installed", 1070))

    def test_offline_or_not_yet_known_is_tried_again(self):
        self.write({"state": "error", "version": "2.6.0", "error": "could not record the update", "at": 1000})
        self.answer = agent.URLError("offline")
        settled = agent.report_boot_outcome(None)
        self.answer = 409
        settled = agent.report_boot_outcome(settled)
        self.answer = 200
        settled = agent.report_boot_outcome(settled)
        agent.report_boot_outcome(settled)
        self.assertEqual(len(self.sent), 3)
        self.assertEqual(settled, ("error", 1000))

    def test_a_report_the_control_plane_refuses_is_not_sent_again(self):
        self.write({"state": "fallback", "version": "2.6.0", "at": 1000})
        self.answer = 404  # a Worker without the route
        settled = agent.report_boot_outcome(None)
        agent.report_boot_outcome(settled)
        self.assertEqual(len(self.sent), 1)

    def test_only_a_root_written_regular_file_is_read(self):
        reader = self.saved["read_boot_report"]
        self.write({"state": "installed", "version": "2.6.1", "at": 1000})
        with self.assertRaises(ValueError):
            reader(self.path, owner_uid=os.getuid() + 1)
        link = os.path.join(self.tmp.name, "link.json")
        os.symlink(self.path, link)
        with self.assertRaises(ValueError):
            reader(link, owner_uid=os.getuid())
        for bad in ("not json", "[]", json.dumps({"state": "installed", "version": "2.6.1"}),
                    json.dumps({"state": "installed", "at": True}), " " * (agent.MAX_BOOT_STATUS_BYTES + 1)):
            self.write(bad)
            with self.assertRaises(ValueError, msg=bad[:40]):
                reader(self.path, owner_uid=os.getuid())

    def test_an_unreadable_status_is_reported_in_the_log_once(self):
        logged = []
        saved_log = agent.log
        agent.log = logged.append
        try:
            self.write("not json")
            settled = agent.report_boot_outcome(None)
            agent.report_boot_outcome(settled)
        finally:
            agent.log = saved_log
        self.assertEqual(len(logged), 1)
        self.assertEqual(self.sent, [])

    def test_the_reported_states_agree_across_the_three_programs(self):
        with open(os.path.join(CHROOT, "usr/local/sbin/labkiosk-boot-slots"), encoding="utf-8") as handle:
            source = handle.read()
        written = set(re.findall(r'write_status\("([a-z-]+)"', source))
        # cmd_check passes classify()'s own name for these two.
        passed_through = re.search(r'if kind in \(([^)]*)\):\n\s+write_status\(kind', source)
        written |= set(re.findall(r'"([a-z-]+)"', passed_through.group(1)))
        self.assertLessEqual(set(agent.BOOT_REPORT_STATES), written, "every reported state is one boot-slots writes")
        worker = os.path.join(os.path.dirname(ROOT), "cloudflare-control", "src", "boot_report.ts")
        with open(worker, encoding="utf-8") as handle:
            declared = re.search(r"BOOT_REPORT_STATES = \[([^\]]*)\]", handle.read()).group(1)
        self.assertEqual(set(re.findall(r'"([a-z-]+)"', declared)), set(agent.BOOT_REPORT_STATES))


class BootConfirmation(unittest.TestCase):
    """labkiosk-boot-slots check, against a boot partition in a temporary directory."""

    def setUp(self):
        import contextlib
        self.tmp = tempfile.TemporaryDirectory()
        self.medium = os.path.join(self.tmp.name, "medium")
        self.boot_dir = os.path.join(self.medium, "boot", "grub")
        os.makedirs(self.boot_dir)
        self.saved = {name: getattr(bootslots, name) for name in (
            "BOOT_MEDIUM", "STATUS_DIR", "STATUS_FILE", "kernel_args", "wait_until_healthy",
            "run", "boot_partition_writable")}
        bootslots.BOOT_MEDIUM = self.medium
        bootslots.STATUS_DIR = os.path.join(self.tmp.name, "run")
        bootslots.STATUS_FILE = os.path.join(bootslots.STATUS_DIR, "status.json")
        bootslots.boot_partition_writable = contextlib.nullcontext
        self.commands = []
        bootslots.run = self.commands.append

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(bootslots, name, value)
        self.tmp.cleanup()

    def boot(self, version, env, healthy=True):
        bootslots.write_env(self.boot_dir, env)
        bootslots.kernel_args = lambda: ["boot=live", f"live-media-path=/images/{version}",
                                         "labkiosk.installed=1"]
        bootslots.wait_until_healthy = lambda probe: healthy
        result = bootslots.cmd_check()
        with open(bootslots.STATUS_FILE, encoding="utf-8") as handle:
            status = json.load(handle)
        return result, status, bootslots.read_env(self.boot_dir)

    def test_a_healthy_try_becomes_current(self):
        result, status, env = self.boot("2.6.1", {"current": "2.6.0", "next": "2.6.1", "next_tries": "0"})
        self.assertEqual(result["state"], "installed")
        self.assertEqual(status["state"], "installed")
        self.assertEqual(env, {"current": "2.6.1", "previous": "2.6.0"})
        self.assertEqual(self.commands, [])

    def test_an_unhealthy_try_reboots_into_the_old_image(self):
        before = {"current": "2.6.0", "next": "2.6.1", "next_tries": "0"}
        result, status, env = self.boot("2.6.1", before, healthy=False)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(env, before)
        self.assertEqual(self.commands, [["systemctl", "reboot"]])

    def test_the_old_image_reports_the_rollback_and_leaves_it_on_record(self):
        before = {"current": "2.6.0", "next": "2.6.1", "next_tries": "0"}
        _, status, env = self.boot("2.6.0", before)
        self.assertEqual((status["state"], status["failed"]), ("rolled-back", "2.6.1"))
        self.assertEqual(env, before)
        self.assertEqual(self.commands, [])

    def test_an_ordinary_boot_changes_nothing(self):
        _, status, env = self.boot("2.6.0", {"current": "2.6.0", "previous": "2.5.1"})
        self.assertEqual(status["state"], "running")
        self.assertEqual(env, {"current": "2.6.0", "previous": "2.5.1"})

    def test_a_promotion_that_cannot_be_written_is_reported_as_an_error(self):
        before = {"current": "2.6.0", "next": "2.6.1", "next_tries": "0"}
        bootslots.write_env(self.boot_dir, before)
        bootslots.kernel_args = lambda: ["boot=live", "live-media-path=/images/2.6.1", "labkiosk.installed=1"]
        bootslots.wait_until_healthy = lambda probe: True
        real_write_env = bootslots.write_env

        def failing_write_env(boot_dir, values):
            raise OSError(5, "Input/output error")

        bootslots.write_env = failing_write_env
        try:
            with self.assertRaises(OSError):
                bootslots.cmd_check()
        finally:
            bootslots.write_env = real_write_env
        with open(bootslots.STATUS_FILE, encoding="utf-8") as handle:
            status = json.load(handle)
        self.assertEqual(status["state"], "error")
        self.assertIn("could not record the update", status["error"])
        self.assertIn("Input/output error", status["error"])
        self.assertEqual(bootslots.read_env(self.boot_dir), before)

    def test_the_live_iso_has_nothing_to_confirm(self):
        bootslots.kernel_args = lambda: ["boot=live", "components"]
        self.assertEqual(bootslots.cmd_check(), {"state": "live"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
