#!/usr/bin/env python3
"""
Swap, the journal on the data partition, and recovery after a restart nobody
asked for.

labkiosk-logs (root) keeps the journal on LABKIOSK_DATA for seven days and
writes a report for each boot that ended without shutting down; the agent
sends each report once. labkiosk-swap opens the installed disk's swap
partition with a key for one boot only. These tests drive the parts that can
run without root and pin the image configuration the rest depends on.

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

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROOT = os.path.join(ROOT, "config", "includes.chroot")


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as handle:
        return handle.read()


logs = load("labkiosk_logs", os.path.join(CHROOT, "usr/local/sbin/labkiosk-logs"))
agent = load("labkiosk_agent_recovery", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))
installer = load("labkiosk_install_recovery", os.path.join(CHROOT, "usr/local/bin/labkiosk-install"))

logs.log = lambda message: None

BOOT_A = "a" * 32
BOOT_B = "b" * 32
MACHINE_A = "1" * 32
MACHINE_B = "2" * 32


class FakeRun:
    """journalctl as labkiosk-logs calls it: the text tail, then the last entry as JSON."""

    def __init__(self, text, last_entry, returncode=0):
        self.text, self.last_entry, self.returncode = text, last_entry, returncode
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        if "--output=json" in cmd:
            out = json.dumps(self.last_entry) + "\n" if self.last_entry else ""
        else:
            out = self.text
        return subprocess.CompletedProcess(cmd, self.returncode, stdout=out, stderr="")


class RestartReportContents(unittest.TestCase):
    """What labkiosk-logs writes about a boot that never shut down."""

    PREVIOUS = {"bootId": BOOT_A, "version": "2.6.1", "startedAt": 1000, "clean": False}

    def test_the_end_of_that_boots_journal_is_sent(self):
        run = FakeRun("first\nlast line\n", {"__REALTIME_TIMESTAMP": "4600000000"})
        report = logs.restart_report(self.PREVIOUS, "/var/log/journal", watchdog=False, run=run)
        self.assertEqual(report, {
            "bootId": BOOT_A, "kind": "unexpected_restart", "version": "2.6.1",
            "startedAt": 1000, "endedAt": 4600, "log": "first\nlast line\n",
        })
        for cmd in run.calls:
            self.assertIn(f"--boot={BOOT_A}", cmd)
            self.assertIn("--directory=/var/log/journal", cmd)

    def test_a_watchdog_reset_is_named(self):
        run = FakeRun("x\n", {"__REALTIME_TIMESTAMP": "2000000000"})
        self.assertEqual(logs.restart_report(self.PREVIOUS, "/j", True, run)["kind"], "watchdog_reset")

    def test_the_log_keeps_whole_lines_within_the_limit(self):
        lines = "".join(f"line {i:06d}\n" for i in range(5000))
        run = FakeRun(lines, {"__REALTIME_TIMESTAMP": "2000000000"})
        tail = logs.restart_report(self.PREVIOUS, "/j", False, run)["log"]
        self.assertLessEqual(len(tail), logs.REPORT_LOG_MAX_CHARS)
        self.assertTrue(tail.startswith("line "))
        self.assertTrue(tail.endswith("line 004999\n"))

    def test_a_boot_with_no_journal_still_gets_a_report(self):
        run = FakeRun("", None, returncode=1)
        report = logs.restart_report(self.PREVIOUS, "/j", False, run)
        self.assertEqual((report["startedAt"], report["endedAt"]), (1000, 1000))
        self.assertIn("No journal entries", report["log"])

    def test_a_bad_version_or_clock_is_not_passed_on(self):
        previous = {"bootId": BOOT_A, "version": "2.6.1; rm", "startedAt": 9000}
        run = FakeRun("x\n", {"__REALTIME_TIMESTAMP": "5000000000"})
        report = logs.restart_report(previous, "/j", False, run)
        self.assertIsNone(report["version"])
        self.assertEqual(report["startedAt"], report["endedAt"])


class WatchdogBootStatus(unittest.TestCase):
    def test_only_the_card_reset_bit_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(logs.watchdog_reset(os.path.join(tmp, "missing")))
            for name, value in (("watchdog0", "0"), ("watchdog1", "garbage"), ("watchdog2", "1")):
                os.makedirs(os.path.join(tmp, name))
                with open(os.path.join(tmp, name, "bootstatus"), "w", encoding="ascii") as handle:
                    handle.write(value + "\n")
            self.assertFalse(logs.watchdog_reset(tmp))
            with open(os.path.join(tmp, "watchdog2", "bootstatus"), "w", encoding="ascii") as handle:
                handle.write("32\n")
            self.assertTrue(logs.watchdog_reset(tmp))


class SevenDays(unittest.TestCase):
    """Reports and earlier boots' journals are deleted after seven days."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = int(time.time())
        self.old = self.now - logs.RETENTION_SECONDS - 60

    def touch(self, path, size=0, mtime=None):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(b"x" * size)
        if mtime is not None:
            os.utime(path, (mtime, mtime))

    def test_old_and_stray_reports_are_deleted(self):
        reports = os.path.join(self.tmp.name, "reports")
        self.touch(os.path.join(reports, f"{BOOT_A}.json"))
        self.touch(os.path.join(reports, f"{BOOT_B}.json"), mtime=self.old)
        self.touch(os.path.join(reports, "notes.txt"))
        os.symlink("/etc/passwd", os.path.join(reports, f"{'c' * 32}.json"))
        fd = os.open(reports, os.O_RDONLY | os.O_DIRECTORY)
        try:
            logs.prune_reports(fd, self.now)
        finally:
            os.close(fd)
        self.assertEqual(os.listdir(reports), [f"{BOOT_A}.json"])
        self.assertTrue(os.path.exists("/etc/passwd"))

    def test_earlier_boots_journals_go_after_seven_days(self):
        journal = os.path.join(self.tmp.name, "journal")
        self.touch(os.path.join(journal, MACHINE_A, "system.journal"), mtime=self.old)
        self.touch(os.path.join(journal, MACHINE_B, "system.journal"))
        current = "3" * 32
        self.touch(os.path.join(journal, current, "system.journal"), mtime=self.old)
        self.touch(os.path.join(journal, "not-an-id", "x"), mtime=self.old)
        logs.prune_journal(journal, current, self.now)
        self.assertEqual(sorted(os.listdir(journal)), sorted([MACHINE_B, current, "not-an-id"]))

    def test_the_oldest_journals_go_when_all_boots_together_are_too_big(self):
        journal = os.path.join(self.tmp.name, "journal")
        self.touch(os.path.join(journal, MACHINE_A, "system.journal"), size=600, mtime=self.now - 200)
        self.touch(os.path.join(journal, MACHINE_B, "system.journal"), size=600, mtime=self.now - 100)
        current = "3" * 32
        self.touch(os.path.join(journal, current, "system.journal"), size=600)
        logs.prune_journal(journal, current, self.now, max_bytes=1500)
        self.assertEqual(sorted(os.listdir(journal)), sorted([MACHINE_B, current]))

    def test_a_link_in_the_journal_folder_is_never_followed(self):
        outside = os.path.join(self.tmp.name, "outside")
        self.touch(os.path.join(outside, "keep"), mtime=self.old)
        journal = os.path.join(self.tmp.name, "journal")
        os.makedirs(journal)
        os.symlink(outside, os.path.join(journal, MACHINE_A))
        logs.prune_journal(journal, "3" * 32, self.now)
        self.assertTrue(os.path.exists(os.path.join(outside, "keep")))


class RootFoldersOnTheKioskPartition(unittest.TestCase):
    """/etc/labkiosk is the kiosk user's; a link it leaves where logs/ goes is moved aside."""

    def test_a_planted_link_is_moved_aside_never_followed(self):
        if os.geteuid() != 0:
            self.skipTest("needs root: the folder must end up root's")
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "target")
            os.makedirs(target)
            os.symlink(target, os.path.join(tmp, "logs"))
            parent = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.close(logs.open_root_dir(parent, "logs", 0o755))
            finally:
                os.close(parent)
            self.assertFalse(os.path.islink(os.path.join(tmp, "logs")))
            self.assertTrue(os.path.isdir(os.path.join(tmp, "logs")))
            aside = [name for name in os.listdir(tmp) if name.startswith("logs.invalid-")]
            self.assertEqual(len(aside), 1)
            self.assertTrue(os.path.islink(os.path.join(tmp, aside[0])))

    def test_a_folder_of_someone_else_is_refused(self):
        if os.geteuid() == 0:
            self.skipTest("root owns whatever it creates")
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "logs"))
            parent = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(RuntimeError):
                    logs.open_root_dir(parent, "logs", 0o755)
            finally:
                os.close(parent)
            self.assertTrue(any(name.startswith("logs.invalid-") for name in os.listdir(tmp)))


class RecordingEachBoot(unittest.TestCase):
    """labkiosk-logs start: report the previous boot only when it did not shut down."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log_dir = os.path.join(self.tmp.name, "logs")
        self.reports = os.path.join(self.log_dir, "reports")
        self.journal = os.path.join(self.log_dir, "journal")
        os.makedirs(self.reports)
        os.makedirs(self.journal)
        self.boot_id = BOOT_B
        saved = {name: getattr(logs, name) for name in (
            "read_id", "watchdog_reset", "agent_gid", "image_version", "boot_started_at", "journal_tail")}
        saved_fchown = os.fchown
        self.addCleanup(lambda: [setattr(logs, k, v) for k, v in saved.items()])
        self.addCleanup(setattr, os, "fchown", saved_fchown)
        # Root gives the files to root and the kiosk group; a test user cannot.
        os.fchown = lambda fd, uid, gid: None
        logs.read_id = lambda path: self.boot_id if path == logs.BOOT_ID_FILE else MACHINE_B
        logs.watchdog_reset = lambda: False
        logs.agent_gid = lambda: os.getgid()
        logs.image_version = lambda: "2.7.0"
        logs.boot_started_at = lambda: 5000
        logs.journal_tail = lambda journal_dir, boot_id, run=None: ("the end\n", 4900)

    def record(self):
        log_fd = os.open(self.log_dir, os.O_RDONLY | os.O_DIRECTORY)
        reports_fd = os.open(self.reports, os.O_RDONLY | os.O_DIRECTORY)
        try:
            logs.record_boot(log_fd, reports_fd, self.journal, int(time.time()))
        finally:
            os.close(reports_fd)
            os.close(log_fd)

    def state(self):
        return json.loads(read(self.log_dir, logs.STATE_FILE_NAME))

    def write_state(self, state):
        with open(os.path.join(self.log_dir, logs.STATE_FILE_NAME), "w", encoding="utf-8") as handle:
            json.dump(state, handle)

    def test_the_first_boot_is_remembered_and_nothing_reported(self):
        self.record()
        self.assertEqual(self.state(), {"bootId": BOOT_B, "version": "2.7.0", "startedAt": 5000, "clean": False})
        self.assertEqual(os.listdir(self.reports), [])

    def test_a_boot_that_shut_down_is_not_reported(self):
        self.write_state({"bootId": BOOT_A, "version": "2.6.1", "startedAt": 1000, "clean": True})
        self.record()
        self.assertEqual(os.listdir(self.reports), [])
        self.assertEqual(self.state()["bootId"], BOOT_B)

    def test_a_boot_that_never_shut_down_is_reported_once(self):
        self.write_state({"bootId": BOOT_A, "version": "2.6.1", "startedAt": 1000, "clean": False})
        self.record()
        self.assertEqual(os.listdir(self.reports), [f"{BOOT_A}.json"])
        report = json.loads(read(self.reports, f"{BOOT_A}.json"))
        self.assertEqual(report, {"bootId": BOOT_A, "kind": "unexpected_restart", "version": "2.6.1",
                                  "startedAt": 1000, "endedAt": 4900, "log": "the end\n"})
        self.assertEqual(os.stat(os.path.join(self.reports, f"{BOOT_A}.json")).st_mode & 0o777, 0o640)
        # The service starting again in the same boot changes nothing.
        os.remove(os.path.join(self.reports, f"{BOOT_A}.json"))
        self.record()
        self.assertEqual(os.listdir(self.reports), [])
        self.assertEqual(self.state()["startedAt"], 5000)

    def test_an_unreadable_state_reports_nothing(self):
        with open(os.path.join(self.log_dir, logs.STATE_FILE_NAME), "w", encoding="utf-8") as handle:
            handle.write('{"bootId": "../../etc"}')
        self.record()
        self.assertEqual(os.listdir(self.reports), [])
        self.assertEqual(self.state()["bootId"], BOOT_B)


class AgentSendsRestartReports(unittest.TestCase):
    """The agent sends each report once and remembers that on the data partition."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.reports = os.path.join(self.tmp.name, "reports")
        os.makedirs(self.reports)
        self.ledger = os.path.join(self.tmp.name, "sent.json")
        saved = {name: getattr(agent, name) for name in (
            "read_restart_reports", "post_restart_report", "save_sent_restart_reports", "log")}
        saved_state = dict(agent.state)

        def restore():
            for name, value in saved.items():
                setattr(agent, name, value)
            agent.state.clear()
            agent.state.update(saved_state)

        self.addCleanup(restore)
        self.reader = saved["read_restart_reports"]
        agent.log = lambda message: None
        agent.state["isConfigured"] = True
        agent.read_restart_reports = lambda: saved["read_restart_reports"](self.reports, owner_uid=os.getuid())
        agent.save_sent_restart_reports = lambda sent: saved["save_sent_restart_reports"](sent, self.ledger)
        self.sent = []
        self.answers = []

        def post(report):
            self.sent.append(report["bootId"])
            answer = self.answers.pop(0) if self.answers else 200
            if isinstance(answer, Exception):
                raise answer
            return answer

        agent.post_restart_report = post
        self.progress = {"sent": set(), "logged": set(), "held": False}

    def add(self, boot_id, ended_at=2000, **extra):
        report = {"bootId": boot_id, "kind": "unexpected_restart", "version": None,
                  "startedAt": 1000, "endedAt": ended_at, "log": "x\n", **extra}
        with open(os.path.join(self.reports, f"{boot_id}.json"), "w", encoding="utf-8") as handle:
            json.dump(report, handle)

    def ledger_ids(self):
        return set(json.loads(read(self.ledger))["sent"])

    def test_each_report_is_sent_once_oldest_first(self):
        self.add(BOOT_B, ended_at=3000)
        self.add(BOOT_A, ended_at=2000)
        agent.report_restarts(self.progress)
        agent.report_restarts(self.progress)
        self.assertEqual(self.sent, [BOOT_A, BOOT_B])
        self.assertEqual(self.ledger_ids(), {BOOT_A, BOOT_B})
        self.assertEqual(os.stat(self.ledger).st_mode & 0o777, 0o600)

    def test_the_list_survives_a_restart_of_the_agent(self):
        self.add(BOOT_A)
        agent.report_restarts(self.progress)
        progress = {"sent": agent.load_sent_restart_reports(self.ledger), "logged": set(), "held": False}
        agent.report_restarts(progress)
        self.assertEqual(self.sent, [BOOT_A])

    def test_offline_or_not_yet_known_is_tried_again(self):
        self.add(BOOT_A)
        self.answers = [agent.URLError("offline"), 409, 503, 200]
        for _ in range(5):
            agent.report_restarts(self.progress)
        self.assertEqual(self.sent, [BOOT_A] * 4)
        self.assertEqual(self.ledger_ids(), {BOOT_A})

    def test_a_refused_report_is_not_sent_again(self):
        self.add(BOOT_A)
        self.answers = [400]
        agent.report_restarts(self.progress)
        agent.report_restarts(self.progress)
        self.assertEqual(self.sent, [BOOT_A])

    def test_too_many_holds_the_rest_until_the_next_start(self):
        self.add(BOOT_A, ended_at=2000)
        self.add(BOOT_B, ended_at=3000)
        self.answers = [200, 429]
        agent.report_restarts(self.progress)
        agent.report_restarts(self.progress)
        self.assertEqual(self.sent, [BOOT_A, BOOT_B])
        self.assertTrue(self.progress["held"])
        self.assertEqual(self.ledger_ids(), {BOOT_A})

    def test_an_unenrolled_workstation_sends_nothing(self):
        agent.state["isConfigured"] = False
        self.add(BOOT_A)
        agent.report_restarts(self.progress)
        self.assertEqual(self.sent, [])

    def test_a_deleted_report_is_forgotten(self):
        self.add(BOOT_A)
        agent.report_restarts(self.progress)
        os.remove(os.path.join(self.reports, f"{BOOT_A}.json"))
        agent.report_restarts(self.progress)
        self.assertEqual(self.ledger_ids(), set())

    def test_only_root_written_reports_of_their_own_boot_are_read(self):
        self.add(BOOT_A)
        self.add(BOOT_B, bootId=BOOT_A)  # a report claiming another boot's id
        os.symlink(os.path.join(self.reports, f"{BOOT_A}.json"), os.path.join(self.reports, f"{'c' * 32}.json"))
        with open(os.path.join(self.reports, f"{'d' * 32}.json"), "w", encoding="utf-8") as handle:
            handle.write(" " * (agent.MAX_RESTART_REPORT_BYTES + 1))
        reports, problems = agent.read_restart_reports()
        self.assertEqual([r["bootId"] for r in reports], [BOOT_A])
        self.assertEqual(len(problems), 3)
        # Someone else's folder is not read at all.
        reports, problems = self.reader(self.reports, owner_uid=os.getuid() + 1)
        self.assertEqual(reports, [])
        self.assertEqual(len(problems), 1)
        # A missing folder (a live session, an older disk) is not a problem.
        self.assertEqual(self.reader(os.path.join(self.tmp.name, "none")), ([], []))

    def test_an_unreadable_report_keeps_the_list(self):
        self.add(BOOT_A)
        agent.report_restarts(self.progress)
        with open(os.path.join(self.reports, f"{BOOT_B}.json"), "w", encoding="utf-8") as handle:
            handle.write("not json")
        os.remove(os.path.join(self.reports, f"{BOOT_A}.json"))
        agent.report_restarts(self.progress)
        self.assertEqual(self.ledger_ids(), {BOOT_A})

    def test_a_damaged_list_is_treated_as_empty(self):
        for text in ("not json", "[]", '{"sent": "x"}', '{"sent": ["../x", 5]}'):
            with self.subTest(text=text):
                with open(self.ledger, "w", encoding="utf-8") as handle:
                    handle.write(text)
                self.assertEqual(agent.load_sent_restart_reports(self.ledger), set())
        self.assertEqual(agent.load_sent_restart_reports(os.path.join(self.tmp.name, "none")), set())

    def test_the_report_fields_match_the_worker(self):
        worker = read(ROOT, "..", "cloudflare-control", "src", "boot_report.ts")
        for field in ("bootId", "kind", "version", "startedAt", "endedAt", "log"):
            self.assertIn(f"body.{field}", worker)
        kinds = re.search(r"RESTART_KINDS = \[([^\]]*)\]", worker).group(1)
        self.assertEqual(set(re.findall(r'"([a-z_]+)"', kinds)), {"unexpected_restart", "watchdog_reset"})
        self.assertIn('"/api/devices/restart-report"', read(ROOT, "..", "cloudflare-control", "src", "index.ts"))


class SwapPartition(unittest.TestCase):
    """The installer names the swap partition by PARTUUID; GRUB passes it on; nothing else is opened."""

    PARTUUID = "6c1f3d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f"

    def test_the_installer_records_the_partuuid_for_grub(self):
        orig = installer.run_cmd
        self.addCleanup(setattr, installer, "run_cmd", orig)
        calls = []
        with tempfile.TemporaryDirectory() as grub_dir:
            installer.run_cmd = lambda cmd, check=True: calls.append(cmd) or self.PARTUUID
            installer.write_swap_partition_id(grub_dir, "/dev/sda5")
            self.assertEqual(read(grub_dir, installer.SWAP_ID_FILE_NAME), f'set swap_partuuid="{self.PARTUUID}"\n')
        self.assertEqual(calls, [["blkid", "-s", "PARTUUID", "-o", "value", "/dev/sda5"]])

    def test_the_installer_refuses_a_missing_partuuid(self):
        orig = installer.run_cmd
        self.addCleanup(setattr, installer, "run_cmd", orig)
        with tempfile.TemporaryDirectory() as grub_dir:
            for answer in ("", 'x"; set superusers=""'):
                with self.subTest(answer=answer):
                    installer.run_cmd = lambda cmd, check=True, answer=answer: answer
                    with self.assertRaises(RuntimeError):
                        installer.write_swap_partition_id(grub_dir, "/dev/sda5")
                    self.assertFalse(os.path.exists(os.path.join(grub_dir, installer.SWAP_ID_FILE_NAME)))

    def test_the_installer_makes_a_swap_partition_before_the_data_partition(self):
        source = read(CHROOT, "usr/local/bin/labkiosk-install")
        self.assertIn('"SWAP", "linux-swap"', source)
        self.assertIn("write_swap_partition_id(", source.split("def write_swap_partition_id")[0])

    def test_every_installed_command_line_names_the_swap_partition(self):
        cfg = read(CHROOT, "usr/share/labkiosk/boot/grub.cfg")
        self.assertIn(installer.SWAP_ID_FILE_NAME, cfg)
        kernels = [line.split() for line in cfg.splitlines() if line.strip().startswith("linux ")]
        self.assertTrue(kernels)
        for args in kernels:
            self.assertIn("labkiosk.swap=$swap_partuuid", args)

    def test_the_swap_script_checks_before_it_overwrites(self):
        script = read(CHROOT, "usr/local/sbin/labkiosk-swap")
        self.assertIn("0657fd6d-a4ab-43c4-84e5-0933c84b4f4f", script)
        self.assertIn("--key-file /dev/urandom", script)
        open_at = script.index("cryptsetup open")
        for check in ("PARTTYPE", "PKNAME", "MOUNTPOINTS"):
            self.assertLess(script.index(check), open_at, check)
        result = subprocess.run(["sh", "-n", os.path.join(CHROOT, "usr/local/sbin/labkiosk-swap")],
                                stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_live_session_or_an_older_disk_opens_nothing(self):
        script = read(CHROOT, "usr/local/sbin/labkiosk-swap")
        with tempfile.TemporaryDirectory() as tmp:
            for cmdline in ("boot=live components",
                            "boot=live labkiosk.installed=1 labkiosk.data=0f3c2a51-7d4e-4b8a-9c1d-2e5f6a7b8c9d",
                            "boot=live labkiosk.installed=1 labkiosk.swap=/dev/sda1"):
                with self.subTest(cmdline=cmdline):
                    cmdline_file = os.path.join(tmp, "cmdline")
                    with open(cmdline_file, "w", encoding="utf-8") as handle:
                        handle.write(cmdline + "\n")
                    copy = os.path.join(tmp, "swap")
                    with open(copy, "w", encoding="utf-8") as handle:
                        handle.write(script.replace("/proc/cmdline", cmdline_file))
                    result = subprocess.run(["sh", copy, "start"], stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, text=True,
                                            env={"PATH": "/usr/bin:/bin"})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertNotIn("Swap on", result.stderr)


class ImageConfiguration(unittest.TestCase):
    """The pieces the services above rely on are in the image."""

    def test_the_packages_are_listed(self):
        packages = {line.split("#")[0].strip() for line in
                    read(ROOT, "config/package-lists/kiosk.list.chroot").splitlines()}
        for package in ("systemd-zram-generator", "cryptsetup-bin"):
            self.assertIn(package, packages)

    def test_compressed_ram_comes_before_the_partition(self):
        zram = read(CHROOT, "etc/systemd/zram-generator.conf")
        self.assertIn("[zram0]", zram)
        priority = int(re.search(r"^swap-priority\s*=\s*(\d+)", zram, re.MULTILINE).group(1))
        swap = read(CHROOT, "usr/local/sbin/labkiosk-swap")
        self.assertGreater(priority, int(re.search(r"^SWAP_PRIORITY=(\d+)", swap, re.MULTILINE).group(1)))

    def test_the_services_are_enabled_and_the_journal_starts_in_ram(self):
        hook = read(ROOT, "config/hooks/live/01-lockdown.hook.chroot")
        self.assertIn("systemctl enable labkiosk-logs.service", hook)
        self.assertIn("systemctl enable labkiosk-swap.service", hook)
        self.assertIn("rm -rf /var/log/journal", hook)
        for unit in ("labkiosk-logs.service", "labkiosk-swap.service"):
            text = read(CHROOT, "etc/systemd/system", unit)
            self.assertIn("Before=labkiosk-session.service", text)
            self.assertIn("WantedBy=multi-user.target", text)
        self.assertIn("ConditionKernelCommandLine=labkiosk.installed=1",
                      read(CHROOT, "etc/systemd/system/labkiosk-logs.service"))

    def test_the_journal_keeps_seven_days(self):
        conf = read(CHROOT, "etc/systemd/journald.conf.d/labkiosk.conf")
        self.assertIn("MaxRetentionSec=7day", conf)
        self.assertEqual(logs.RETENTION_SECONDS, 7 * 86400)

    def test_a_hang_or_a_panic_restarts_the_workstation(self):
        watchdog = read(CHROOT, "etc/systemd/system.conf.d/labkiosk-watchdog.conf")
        self.assertRegex(watchdog, r"(?m)^RuntimeWatchdogSec=\d+s$")
        sysctl = read(CHROOT, "etc/sysctl.d/90-labkiosk-recovery.conf")
        self.assertRegex(sysctl, r"(?m)^kernel\.panic\s*=\s*[1-9]\d*$")
        # An oops is often survivable; turning every one into a reboot risks a loop.
        self.assertNotIn("panic_on_oops", sysctl)


if __name__ == "__main__":
    unittest.main()
