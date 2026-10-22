#!/usr/bin/env python3
"""
Printing, off until an administrator turns it on (Settings -> Printing).

    labkiosk-printing  the root helper: checks every printer again, starts CUPS
                       on a local socket only, makes the queues exactly the
                       ones listed, and lets Chromium print; disable undoes it
    the agent          turns the organization's configuration into the
                       helper's arguments, one change at a time, retries a
                       printer that could not be set up, and tells the bar
                       when Chromium may print
    the image          ships CUPS masked, the print preview without "Save as
                       PDF", and GTK's dialog with no "Print to File"

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import importlib.machinery
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROOT = os.path.join(ROOT, "config", "includes.chroot")
REPO = os.path.dirname(ROOT)


def load(name, path):
    """Import a module by path, including the ones with no .py suffix."""
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as handle:
        return handle.read()


helper = load("labkiosk_printing", os.path.join(CHROOT, "usr/local/sbin/labkiosk-printing"))
helper.log = lambda message: None
agent = load("labkiosk_agent_printing", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))
LOGGED = []
agent.log = LOGGED.append
generator = load("generate_chromium_policy", os.path.join(ROOT, "tools/generate-chromium-policy.py"))

QUEUE_A = "labkiosk-0123456789abcdef"
QUEUE_B = "labkiosk-fedcba9876543210"

# The same addresses the control plane's tests use (cloudflare-control/test/worker.test.ts),
# with the scheme in lower case, which is how the control plane stores and sends it.
GOOD_URIS = [
    "ipp://printer.example.org/ipp/print",
    "ipps://printer.example.org:443/ipp/print",
    "ipp://Printer01/printers/Office_Laser",
    "ipp://192.168.1.40/ipp/print",
    "ipp://10.0.0.7:631/printers/Room%2012",
    "ipps://172.20.3.4/ipp/print",
    "ipp://169.254.10.20",
    "ipp://[fd12:3456::40]/ipp/print",
    "ipp://printer.example.org.",
]
BAD_URIS = [
    "",
    "file:///etc/passwd",
    "usb://HP/LaserJet",
    "socket://192.168.1.40:9100",
    "lpd://192.168.1.40/queue",
    "http://192.168.1.40:631/ipp/print",
    "IPP://printer.example.org/",
    "ipp://",
    "ipp:///ipp/print",
    "ipp://printer.example.org/ipp/print;reboot",
    "ipp://printer.example.org/$(reboot)",
    "ipp://printer.example.org/`id`",
    "ipp://printer.example.org/a|b",
    "ipp://printer.example.org/a b",
    "ipp://printer.example.org/ipp/print?x=1",
    "ipp://printer.example.org/ipp/print#x",
    "ipp://printer.example.org/%zz",
    "ipp://user:secret@printer.example.org/ipp/print",
    "ipp://printer.example.org:0/ipp/print",
    "ipp://printer.example.org:70000/ipp/print",
    "ipp://localhost/printers/x",
    "ipp://127.0.0.1:631/printers/x",
    "ipp://8.8.8.8/ipp/print",
    "ipp://192.168.1.300/ipp/print",
    "ipp://192.168.01.40/ipp/print",
    "ipp://1234/ipp/print",
    "ipp://-printer.example.org/",
    "ipp://printer..example.org/",
    "ipp://[2001:db8::1]/ipp/print",
    "ipp://[fe80::1]/ipp/print",
    "ipp://[fd00::zz]/",
    "ipp://printer.example.org/ipp/print\n",
    "ipp://printer.example.org/" + "a" * 260,
]


class HelperChecksEveryArgument(unittest.TestCase):
    def test_printer_addresses(self):
        for uri in GOOD_URIS:
            with self.subTest(uri=uri):
                self.assertIsNone(helper.printer_uri_problem(uri))
        for uri in BAD_URIS:
            with self.subTest(uri=uri):
                self.assertIsNotNone(helper.printer_uri_problem(uri))

    def test_printer_names(self):
        self.assertIsNone(helper.printer_name_problem("Library, ground floor"))
        self.assertIsNone(helper.printer_name_problem("Bibliothèque 2e étage"))
        for bad in ("", " ", "a" * 65, "Line\nbreak", "Tab\there", "Info x\u2028y", "nul\x00"):
            with self.subTest(name=bad):
                self.assertIsNotNone(helper.printer_name_problem(bad))

    def test_queue_names_and_the_list(self):
        good = [QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk"]
        self.assertEqual(helper.validate_printers([good]), [tuple(good)])
        for queue in ("labkiosk-0123", "labkiosk-0123456789ABCDEF", "printer", "labkiosk-0123456789abcdef\n",
                      "-x", "labkiosk-0123456789abcdef/../x"):
            with self.subTest(queue=queue):
                with self.assertRaises(ValueError):
                    helper.validate_printers([[queue, good[1], good[2]]])
        with self.assertRaises(ValueError):
            helper.validate_printers([])
        with self.assertRaises(ValueError):
            helper.validate_printers([good, good])
        many = [[f"labkiosk-{i:016x}", good[1], f"P{i}"] for i in range(helper.MAX_PRINTERS + 1)]
        with self.assertRaises(ValueError):
            helper.validate_printers(many)
        self.assertEqual(len(helper.validate_printers(many[:-1])), helper.MAX_PRINTERS)

    def test_a_refused_argument_never_reaches_cups(self):
        calls = []
        with mock.patch.object(helper.os, "geteuid", return_value=0), \
                mock.patch.object(helper, "run", side_effect=lambda *a, **k: calls.append(a) or (True, "")), \
                mock.patch("sys.stdout") as out:
            code = helper.main(["apply", "--printer", QUEUE_A, "file:///etc/shadow", "Front desk"])
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])
        self.assertIn("error", json.loads("".join(c.args[0] for c in out.write.call_args_list)))

    def test_only_root_runs_it(self):
        with mock.patch.object(helper.os, "geteuid", return_value=1000), mock.patch("sys.stdout"):
            self.assertEqual(helper.main(["disable"]), 1)

    def test_the_agent_and_the_helper_agree(self):
        self.assertEqual(agent.PRINTER_URI_PATTERN.pattern, helper.URI_PATTERN.pattern)
        self.assertEqual(agent.PRINTING_MAX_PRINTERS, helper.MAX_PRINTERS)
        self.assertEqual("labkiosk-" + agent.PRINTER_ID_PATTERN.pattern[1:], "labkiosk-[0-9a-f]{16}\\Z")
        self.assertEqual(helper.QUEUE_PATTERN.pattern, "^labkiosk-[0-9a-f]{16}\\Z")
        # Everything the agent lets through reaches the helper's full check;
        # what the agent's shape check already refuses never gets that far.
        for uri in BAD_URIS:
            if agent.PRINTER_URI_PATTERN.match(uri):
                self.assertIsNotNone(helper.printer_uri_problem(uri), uri)


class HelperSetsUpCups(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        for sub in ("share", "cups/ppd", "spool", "policies", "run"):
            os.makedirs(os.path.join(self.dir, sub))
        self.source = os.path.join(self.dir, "share/cupsd.conf")
        with open(self.source, "w", encoding="utf-8") as handle:
            handle.write("Listen /run/cups/cups.sock\n")
        with open(os.path.join(self.dir, "policies/policies.json"), "w", encoding="utf-8") as handle:
            handle.write('{"PrintingEnabled": false}\n')
        paths = {
            "CUPSD_CONF_SOURCE": self.source,
            "CUPSD_CONF": os.path.join(self.dir, "cups/cupsd.conf"),
            "CUPS_PRINTERS_CONF": os.path.join(self.dir, "cups/printers.conf"),
            "CUPS_PPD_DIR": os.path.join(self.dir, "cups/ppd"),
            "CUPS_SPOOL_DIR": os.path.join(self.dir, "spool"),
            "POLICY_DIR": os.path.join(self.dir, "policies"),
            "STATE_DIR": os.path.join(self.dir, "run"),
            "STATE_FILE": os.path.join(self.dir, "run/queues.json"),
        }
        for name, value in paths.items():
            patcher = mock.patch.object(helper, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for target, replacement in ((helper.shutil, "chown"), (helper.time, "sleep")):
            patcher = mock.patch.object(target, replacement, lambda *a, **k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.commands = []
        self.queues = []
        self.unreachable = set()

        def run(command, timeout=helper.COMMAND_TIMEOUT_SECONDS):
            self.commands.append(command)
            if command[:2] == ["lpstat", "-r"]:
                return True, "scheduler is running"
            if command[:2] == ["lpstat", "-e"]:
                return (True, "\n".join(self.queues)) if self.queues else (False, "lpstat: No destinations added.")
            if command[:2] == ["lpadmin", "-x"]:
                self.queues.remove(command[2])
                return True, ""
            if command[:2] == ["lpadmin", "-p"]:
                if command[5] in self.unreachable:
                    return False, "lpadmin: Unable to connect to printer."
                if command[2] not in self.queues:
                    self.queues.append(command[2])
                return True, ""
            return True, ""

        patcher = mock.patch.object(helper, "run", side_effect=run)
        patcher.start()
        self.addCleanup(patcher.stop)

    def policy_path(self):
        return os.path.join(self.dir, "policies", helper.POLICY_NAME)

    def test_apply_sets_up_exactly_the_listed_printers_and_lets_chromium_print(self):
        self.queues = ["Old_Printer"]
        result = helper.apply([(QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk")])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["ready"], [QUEUE_A])
        self.assertTrue(result["policyChanged"])
        self.assertIn(["systemctl", "unmask", "cups.socket"], self.commands)
        self.assertIn(["systemctl", "unmask", "cups.service"], self.commands)
        self.assertNotIn(["systemctl", "unmask", "cups.path"], self.commands)
        self.assertIn(["systemctl", "restart", "cups.service"], self.commands, "a new cupsd.conf restarts it")
        self.assertIn(["lpadmin", "-x", "Old_Printer"], self.commands)
        self.assertIn(["lpadmin", "-p", QUEUE_A, "-E", "-v", "ipp://192.168.1.40/ipp/print", "-m", "everywhere",
                       "-D", "Front desk", "-o", "printer-is-shared=false"], self.commands)
        self.assertEqual(self.queues, [QUEUE_A])
        self.assertEqual(read(self.dir, "cups/cupsd.conf"), "Listen /run/cups/cups.sock\n")
        with open(self.policy_path(), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), {"PrintingEnabled": True})
        self.assertEqual(os.stat(self.policy_path()).st_mode & 0o777, 0o644)
        # Chromium reads the directory in name order, the last file winning.
        self.assertEqual(sorted(os.listdir(os.path.join(self.dir, "policies")))[-1], helper.POLICY_NAME)

    def test_an_unchanged_printer_is_not_asked_again(self):
        printers = [(QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk")]
        helper.apply(printers)
        self.commands.clear()
        result = helper.apply(printers + [(QUEUE_B, "ipp://printer.example.org/ipp/print", "Library")])
        added = [c for c in self.commands if c[:2] == ["lpadmin", "-p"]]
        self.assertEqual([c[2] for c in added], [QUEUE_B])
        self.assertIn(["systemctl", "start", "cups.service"], self.commands)
        self.assertFalse(result["policyChanged"])
        self.commands.clear()
        helper.apply([(QUEUE_A, "ipp://192.168.1.41/ipp/print", "Front desk")])
        self.assertIn(["lpadmin", "-x", QUEUE_B], self.commands)
        self.assertEqual([c[2] for c in self.commands if c[:2] == ["lpadmin", "-p"]], [QUEUE_A], "a new address is set again")

    def test_no_printer_reachable_means_chromium_may_not_print(self):
        helper.apply([(QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk")])
        self.unreachable = {"ipp://192.168.1.99/ipp/print"}
        result = helper.apply([(QUEUE_B, "ipp://192.168.1.99/ipp/print", "Broken")])
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["failed"][0]["queue"], QUEUE_B)
        self.assertFalse(os.path.exists(self.policy_path()))

    def test_one_unreachable_printer_does_not_stop_the_others(self):
        self.unreachable = {"ipp://192.168.1.99/ipp/print"}
        result = helper.apply([(QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk"),
                               (QUEUE_B, "ipp://192.168.1.99/ipp/print", "Broken")])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["ready"], [QUEUE_A])
        self.assertEqual([f["queue"] for f in result["failed"]], [QUEUE_B])
        self.assertTrue(os.path.exists(self.policy_path()))

    def test_a_link_planted_in_the_kiosk_owned_policy_directory_is_replaced_not_followed(self):
        victim = os.path.join(self.dir, "victim")
        with open(victim, "w", encoding="utf-8") as handle:
            handle.write("untouched")
        os.symlink(victim, self.policy_path())
        helper.apply([(QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk")])
        self.assertFalse(os.path.islink(self.policy_path()))
        self.assertEqual(read(victim), "untouched")
        os.unlink(self.policy_path())
        os.symlink(victim, self.policy_path())
        helper.disable()
        self.assertTrue(os.path.exists(victim))

    def test_disable_takes_everything_away(self):
        helper.apply([(QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk")])
        for name, text in (("cups/printers.conf", "<Printer x>\n"), ("cups/ppd/" + QUEUE_A + ".ppd", "*PPD\n"),
                           ("spool/c00001", "job"), ("spool/d00001-001", "pdf"), ("spool/tmp-keep", "x")):
            with open(os.path.join(self.dir, name), "w", encoding="utf-8") as handle:
                handle.write(text)
        self.commands.clear()
        result = helper.disable()
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["policyChanged"])
        self.assertFalse(os.path.exists(self.policy_path()))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "policies/policies.json")))
        for unit in ("cups.service", "cups.socket"):
            self.assertIn(["systemctl", "stop", unit], self.commands)
            self.assertIn(["systemctl", "mask", unit], self.commands)
        self.assertLess(self.commands.index(["systemctl", "stop", "cups.service"]),
                        self.commands.index(["systemctl", "stop", "cups.socket"]))
        self.assertEqual(sorted(os.listdir(os.path.join(self.dir, "spool"))), ["tmp-keep"])
        self.assertEqual(os.listdir(os.path.join(self.dir, "cups/ppd")), [])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "cups/printers.conf")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "run/queues.json")))

    def test_a_failed_start_takes_the_policy_away(self):
        helper.apply([(QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk")])
        with mock.patch.object(helper, "start_cups", side_effect=RuntimeError("CUPS did not start")), \
                mock.patch.object(helper.os, "geteuid", return_value=0), mock.patch("sys.stdout"):
            code = helper.main(["apply", "--printer", QUEUE_A, "ipp://192.168.1.40/ipp/print", "Front desk"])
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(self.policy_path()))


class AgentAppliesPrinting(unittest.TestCase):
    PRINTING = {"enabled": True, "printers": [
        {"id": "0123456789abcdef", "name": "Front desk", "uri": "ipp://192.168.1.40/ipp/print"},
        {"id": "fedcba9876543210", "name": "Library", "uri": "ipps://printer.example.org/ipp/print"},
    ]}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        helper_path = os.path.join(tmp.name, "labkiosk-printing")
        with open(helper_path, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\n")
        saved = {name: getattr(agent, name) for name in ("PRINTING_HELPER", "subprocess")}
        saved_printing = dict(agent._printing)

        def restore():
            for name, value in saved.items():
                setattr(agent, name, value)
            agent._printing.clear()
            agent._printing.update(saved_printing)

        self.addCleanup(restore)
        agent.PRINTING_HELPER = helper_path
        agent._printing.update(wanted=[], ready=False, readyAt=0.0, unavailable=False)
        LOGGED.clear()
        self.calls = []
        self.answer = {"status": "ok", "ready": [], "failed": [], "policy": True, "policyChanged": True}

        def fake_run(command, **kwargs):
            self.calls.append(command)
            return subprocess.CompletedProcess(command, 0, json.dumps(self.answer), "")

        agent.subprocess = mock.Mock(wraps=subprocess)
        agent.subprocess.run = fake_run
        agent.subprocess.SubprocessError = subprocess.SubprocessError

    def test_malformed_means_off(self):
        for value in (None, True, "on", {}, {"enabled": "true", "printers": []}, {"enabled": False, "printers": self.PRINTING["printers"]},
                      {"enabled": True, "printers": "all"},
                      {"enabled": True, "printers": [dict(self.PRINTING["printers"][0])] * (agent.PRINTING_MAX_PRINTERS + 1)}):
            with self.subTest(value=value):
                self.assertEqual(agent.printing_plan(value), [])

    def test_an_unusable_printer_is_dropped_and_the_rest_kept(self):
        good = self.PRINTING["printers"][0]
        bad = [
            {**good, "id": "0123"}, {**good, "id": "../../etc"}, {**good, "uri": "file:///etc/shadow"},
            {**good, "uri": "ipp://x/;reboot"}, {**good, "name": ""}, {**good, "name": "a\nb"}, {**good, "name": "a" * 65},
            {**good, "uri": "IPP://printer/"}, "printer", good,
        ]
        plan = agent.printing_plan({"enabled": True, "printers": [good] + bad})
        self.assertEqual(plan, [("labkiosk-0123456789abcdef", good["uri"], good["name"])], "duplicates dropped too")

    def test_on_runs_the_helper_through_sudo_and_waits_for_chromium(self):
        agent.apply_printing(self.PRINTING)
        plan = agent._printing["wanted"]
        self.assertEqual([q for q, _, _ in plan], ["labkiosk-0123456789abcdef", "labkiosk-fedcba9876543210"])
        self.assertIsNone(agent.printing_pass(plan))
        self.assertEqual(self.calls, [[
            "sudo", "-n", agent.PRINTING_HELPER, "apply",
            "--printer", "labkiosk-0123456789abcdef", "ipp://192.168.1.40/ipp/print", "Front desk",
            "--printer", "labkiosk-fedcba9876543210", "ipps://printer.example.org/ipp/print", "Library",
        ]])
        self.assertFalse(agent.printing_ready(), "not before Chromium has reloaded its policy")
        agent._printing["readyAt"] = time.monotonic() - 1
        self.assertTrue(agent.printing_ready())

    def test_the_same_configuration_again_changes_nothing(self):
        agent.apply_printing(self.PRINTING)
        first = agent._printing["wanted"]
        agent.apply_printing(json.loads(json.dumps(self.PRINTING)))
        self.assertIs(agent._printing["wanted"], first)

    def test_off_hides_the_button_before_the_policy_goes(self):
        agent.apply_printing(self.PRINTING)
        agent.printing_pass(agent._printing["wanted"])
        agent._printing["readyAt"] = 0.0
        self.assertTrue(agent.printing_ready())
        agent.apply_printing({"enabled": False, "printers": []})
        self.assertFalse(agent.printing_ready())
        self.answer = {"status": "ok", "ready": [], "failed": [], "policy": False, "policyChanged": True}
        self.assertIsNone(agent.printing_pass([]))
        self.assertEqual(self.calls[-1], ["sudo", "-n", agent.PRINTING_HELPER, "disable"])
        self.assertFalse(agent.printing_ready())

    def test_an_unreachable_printer_is_tried_again_later(self):
        self.answer = {"status": "ok", "ready": ["labkiosk-0123456789abcdef"],
                       "failed": [{"queue": "labkiosk-fedcba9876543210", "error": "unreachable"}],
                       "policy": True, "policyChanged": True}
        agent.apply_printing(self.PRINTING)
        retry_at = agent.printing_pass(agent._printing["wanted"])
        self.assertAlmostEqual(retry_at - time.monotonic(), agent.PRINTING_RETRY_SECONDS, delta=5)
        self.assertTrue(agent._printing["ready"])

    def test_a_helper_that_fails_leaves_printing_off_and_retries(self):
        self.answer = {"error": "CUPS did not start"}
        agent.apply_printing(self.PRINTING)
        self.assertIsNotNone(agent.printing_pass(agent._printing["wanted"]))
        self.assertFalse(agent._printing["ready"])

        def no_json(command, **kwargs):
            return subprocess.CompletedProcess(command, 1, "sudo: a password is required\n", "")

        agent.subprocess.run = no_json
        self.assertIsNotNone(agent.printing_pass(agent._printing["wanted"]))
        self.assertFalse(agent._printing["ready"])

    def test_an_image_without_the_helper_says_so_once(self):
        agent.PRINTING_HELPER = "/nonexistent/labkiosk-printing"
        agent.apply_printing(self.PRINTING)
        self.assertIsNone(agent.printing_pass(agent._printing["wanted"]))
        self.assertIsNone(agent.printing_pass(agent._printing["wanted"]))
        self.assertEqual(sum("cannot print" in line for line in LOGGED), 1)
        self.assertEqual(self.calls, [])
        self.assertFalse(agent.printing_ready())

    def test_the_control_plane_update_reaches_it(self):
        saved = agent.state["pendingBrowserRestart"]
        self.addCleanup(lambda: agent.state.__setitem__("pendingBrowserRestart", saved))
        agent.state["pendingBrowserRestart"] = False
        agent.apply_control_update({"printing": self.PRINTING})
        self.assertEqual(len(agent._printing["wanted"]), 2)
        agent.apply_control_update({})
        self.assertEqual(len(agent._printing["wanted"]), 2, "an update without the key leaves printing as it is")
        agent.apply_control_update({"printing": {"enabled": False, "printers": []}})
        self.assertEqual(agent._printing["wanted"], [])


class TheImage(unittest.TestCase):
    def test_the_packages_are_the_driverless_minimum(self):
        packages = {line.split("#")[0].strip() for line in read(ROOT, "config/package-lists/kiosk.list.chroot").splitlines()}
        for name in ("cups-daemon", "cups-client", "cups-filters-core-drivers"):
            self.assertIn(name, packages)
        for name in ("cups", "cups-browsed", "cups-filters", "avahi-daemon", "ghostscript", "ipp-usb",
                     "printer-driver-all", "system-config-printer"):
            self.assertNotIn(name, packages)

    def test_cups_ships_masked_and_the_helper_is_the_kiosk_users_only_way_in(self):
        hook = read(ROOT, "config/hooks/live/01-lockdown.hook.chroot")
        self.assertIn("for unit in cups.service cups.socket cups.path; do\n    systemctl disable \"$unit\"\n"
                      "    systemctl mask \"$unit\"\ndone\n", hook)
        self.assertIn("kiosk ALL=(ALL) NOPASSWD: /usr/local/sbin/labkiosk-printing\n", hook)
        self.assertIn("chmod 0440 /etc/sudoers.d/52-labkiosk-printing\n", hook)
        self.assertIn("chmod 0755 /usr/local/sbin/labkiosk-printing\n", hook)
        self.assertIn("gpasswd -d kiosk lpadmin", hook)
        self.assertNotRegex(hook, r"systemctl (enable|start|unmask) cups")

    def test_cupsd_listens_on_its_socket_only(self):
        conf = read(CHROOT, "usr/share/labkiosk/cups/cupsd.conf")
        directives = [line.split() for line in conf.splitlines() if line.strip() and not line.lstrip().startswith("#")]
        listens = [d[1] for d in directives if d[0] in ("Listen", "Port", "SSLListen", "SSLPort")]
        self.assertEqual(listens, ["/run/cups/cups.sock"])
        settings = {d[0]: d[1:] for d in directives}
        self.assertEqual(settings["WebInterface"], ["No"])
        self.assertEqual(settings["Browsing"], ["No"])
        self.assertEqual(settings["DefaultShared"], ["No"])
        self.assertEqual(settings["PreserveJobFiles"], ["No"])
        self.assertNotIn("Allow", conf.replace("Order allow,deny", "").replace("Order deny,allow", ""))
        self.assertEqual(helper.CUPSD_CONF_SOURCE, "/usr/share/labkiosk/cups/cupsd.conf")

    def test_the_system_print_dialog_has_no_print_to_file(self):
        for version in ("gtk-3.0", "gtk-4.0"):
            with self.subTest(version=version):
                ini = read(CHROOT, "etc/xdg", version, "settings.ini")
                self.assertRegex(ini, r"(?m)^\[Settings\]$")
                self.assertRegex(ini, r"(?m)^gtk-print-backends = cups$")

    def test_chromium_prints_nothing_until_the_helper_says_so(self):
        base = json.loads(read(CHROOT, "usr/share/labkiosk/chromium-policy-base.json"))
        self.assertIs(base["PrintingEnabled"], False)
        self.assertEqual(base["PrinterTypeDenyList"], ["pdf", "extension"])
        self.assertIs(base["DisablePrintPreview"], False)
        # The generated boot-time policy carries the same, and nothing in it enables printing.
        rendered = json.loads(generator.render())
        for key in ("PrintingEnabled", "PrinterTypeDenyList", "DisablePrintPreview"):
            self.assertEqual(rendered[key], base[key])
        self.assertEqual(rendered, json.loads(read(CHROOT, "etc/chromium/policies/managed/policies.json")))
        self.assertGreater(helper.POLICY_NAME, "policies.json")
        self.assertEqual(helper.POLICY_DIR, os.path.dirname(agent.CHROMIUM_POLICY_FILE))
        self.assertNotIn("PrintingEnabled", read(CHROOT, "opt/labkiosk/agent/agent.py"))

    def test_the_agent_profile_gives_it_nothing_of_cups(self):
        profile = read(CHROOT, "etc/apparmor.d/labkiosk-agent")
        self.assertNotRegex(profile, r"(?m)^\s*[^#\n]*/etc/cups")
        self.assertNotRegex(profile, r"(?m)^\s*[^#\n]*/var/spool/cups")
        self.assertNotRegex(profile, r"(?m)^\s*[^#\n]*labkiosk-printing\s+[a-zA-Z]*x")
        self.assertIn("\n  /usr/bin/sudo Ux,\n", profile)

    def test_the_bar_offers_print_only_while_printing_is_allowed(self):
        content = read(CHROOT, "opt/labkiosk/extension/content.js")
        background = read(CHROOT, "opt/labkiosk/extension/background.js")
        catalog = json.loads(read(CHROOT, "opt/labkiosk/i18n/en-US.json"))
        self.assertRegex(content, r'<button class="kiosk-btn" id="btn-print"[^>]*\shidden>')
        self.assertIn("kioskPrint.enabled = data.printing === true && !isLocked;", content)
        self.assertIn("@media print { :host { display: none !important; } }", content)
        self.assertIn('message.type === "labkiosk:print-shortcut"', background)
        self.assertIn("{ frameId: 0 }", background)
        self.assertEqual(catalog["bar.print"], "Print")
        self.assertIn("bar.printTitle", catalog)
        self.assertIn('"printing": printing_ready(),', read(CHROOT, "opt/labkiosk/agent/agent.py"))

    def test_the_helper_is_compiled_by_the_documented_checks(self):
        self.assertIn("distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-printing",
                      read(REPO, "AGENTS.md"))


if __name__ == "__main__":
    unittest.main()
