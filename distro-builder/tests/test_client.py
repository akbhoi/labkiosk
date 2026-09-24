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
import os
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

agent.log = lambda message: None
localization.log = lambda message: None

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
        self.assertTrue(agent.validate_worker_url("https://organization.labkiosk.akbhoi.com"))

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
        source = inspect.getsource(agent.telemetry_loop)
        self.assertIn("if err.code in (401, 403):", source)
        self.assertIn("mark_enrolment_rejected()", source)
        self.assertIn("clear_enrolment_rejected()", source)
        # An enrolment must not wait out a minute of back-off for its allowlist.
        self.assertIn("heartbeat_wakeup.wait(backoff)", source)
        self.assertIn("heartbeat_wakeup.set()", inspect.getsource(agent.enroll))


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
