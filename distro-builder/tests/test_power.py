#!/usr/bin/env python3
"""
Power schedules and Wake-on-LAN on the workstation.

The organization's power schedule arrives with the configuration (`power`,
src/power.ts); the agent warns for five minutes at a switch-off time, shuts the
machine down -- never while a system update installs -- and first sets the
hardware clock, through labkiosk-wake-alarm, to switch it on again. A `wake`
command makes the agent broadcast magic packets for workstations that are off
at its site. These tests drive the parts that run without root and pin the
image configuration they rely on.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import importlib.machinery
import importlib.util
import json
import os
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
CHROOT = os.path.join(ROOT, "config", "includes.chroot")
HOOK = os.path.join(ROOT, "config/hooks/live/01-lockdown.hook.chroot")
AGENT_PATH = os.path.join(CHROOT, "opt/labkiosk/agent/agent.py")
HELPER_PATH = os.path.join(CHROOT, "usr/local/sbin/labkiosk-wake-alarm")
POWER_TS = os.path.join(REPO, "cloudflare-control/src/power.ts")


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as handle:
        return handle.read()


agent = load("labkiosk_agent_power", AGENT_PATH)
helper = load("labkiosk_wake_alarm", HELPER_PATH)

# 2026-10-23 is a Friday: index 5 in the control plane's week (Sunday is 0).
FRIDAY = datetime(2026, 10, 23)


def week_with(**days):
    """A week in the agent's normalized form, e.g. week_with(fri=(18*60, 7*60))."""
    names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    week = [None] * 7
    for name, (off, on) in days.items():
        week[names.index(name)] = {"off": off, "on": on}
    return week


class ScheduleArithmetic(unittest.TestCase):
    def test_the_week_is_validated_or_dropped_whole(self):
        raw = {"week": [None, {"off": 1080, "on": 450}, None, None, None, {"off": 1080, "on": None}, None]}
        self.assertEqual(agent.normalize_power_week(raw)[1], {"off": 1080, "on": 450})
        self.assertEqual(agent.normalize_power_week(raw)[5], {"off": 1080, "on": None})
        for bad in (None, [], {"week": [None] * 6}, {"week": [None] * 7},
                    {"week": [{"off": 1440, "on": None}] + [None] * 6},
                    {"week": [{"off": True, "on": None}] + [None] * 6},
                    {"week": [{"off": "18:00", "on": None}] + [None] * 6},
                    {"week": [{"off": 600, "on": -1}] + [None] * 6},
                    {"week": ["x"] + [None] * 6}):
            self.assertIsNone(agent.normalize_power_week(bad), bad)

    def test_days_are_counted_from_sunday_like_the_control_plane(self):
        self.assertEqual(agent.schedule_day(FRIDAY), 5)
        self.assertEqual(agent.schedule_day(FRIDAY + timedelta(days=2)), 0)

    def test_a_switch_off_fires_once_when_the_clock_passes_it(self):
        week = week_with(fri=(18 * 60, None))
        off = FRIDAY.replace(hour=18)
        self.assertEqual(agent.switch_off_due(week, off - timedelta(seconds=10), off + timedelta(seconds=5)), off)
        # The next check is after it: nothing more.
        self.assertIsNone(agent.switch_off_due(week, off + timedelta(seconds=5), off + timedelta(seconds=20)))
        # Before it, and on another day: nothing.
        self.assertIsNone(agent.switch_off_due(week, off - timedelta(seconds=30), off - timedelta(seconds=15)))
        thursday = off - timedelta(days=1)
        self.assertIsNone(agent.switch_off_due(week, thursday - timedelta(seconds=10), thursday + timedelta(seconds=5)))

    def test_a_clock_change_fires_nothing(self):
        week = week_with(fri=(18 * 60, None))
        off = FRIDAY.replace(hour=18)
        # The first time sync after boot jumps the clock past the switch-off.
        self.assertIsNone(agent.switch_off_due(week, off - timedelta(hours=3), off + timedelta(seconds=5)))
        # And a clock set back across it.
        self.assertIsNone(agent.switch_off_due(week, off + timedelta(seconds=5), off - timedelta(seconds=10)))
        # No schedule at all.
        self.assertIsNone(agent.switch_off_due(None, off - timedelta(seconds=10), off + timedelta(seconds=5)))

    def test_a_switch_off_at_midnight_belongs_to_the_day_it_starts(self):
        week = week_with(sat=(0, None))
        midnight = FRIDAY + timedelta(days=1)
        self.assertEqual(agent.switch_off_due(week, midnight - timedelta(seconds=5), midnight + timedelta(seconds=10)), midnight)

    def test_the_next_switch_on_is_found_across_the_weekend(self):
        week = week_with(mon=(18 * 60, 7 * 60 + 30), fri=(18 * 60, None))
        monday = datetime(2026, 10, 26, 7, 30)
        self.assertEqual(agent.next_switch_on(week, FRIDAY.replace(hour=18)), monday)
        # Exactly at it, the next one is a week later.
        self.assertEqual(agent.next_switch_on(week, monday), monday + timedelta(days=7))
        self.assertIsNone(agent.next_switch_on(week_with(fri=(18 * 60, None)), FRIDAY))
        self.assertIsNone(agent.next_switch_on(None, FRIDAY))

    def test_the_next_switch_on_is_always_inside_the_helpers_window(self):
        # Whatever the day and time, the furthest switch-on is a week away,
        # which labkiosk-wake-alarm accepts (with an hour for daylight saving).
        for day in range(7):
            week = [None] * 7
            week[day] = {"off": 22 * 60, "on": 6 * 60}
            for hours in range(0, 24 * 7, 5):
                after = FRIDAY + timedelta(hours=hours, minutes=7)
                found = agent.next_switch_on(week, after)
                self.assertIsNotNone(found)
                lead = (found - after).total_seconds()
                self.assertGreater(lead, 0)
                self.assertLessEqual(lead, 7 * 86400)
        self.assertGreaterEqual(helper.MAX_LEAD_SECONDS, 7 * 86400 + agent.WAKE_MIN_LEAD_SECONDS + 3600)
        self.assertGreaterEqual(agent.WAKE_MIN_LEAD_SECONDS, helper.MIN_LEAD_SECONDS)


class SwitchOff(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = (agent.POWER_PENDING_FILE, dict(agent.power_state))
        agent.POWER_PENDING_FILE = os.path.join(self.tmp.name, "power-pending.json")
        agent.power_state["week"] = week_with(fri=(18 * 60, 7 * 60))
        agent.power_state["pending"] = None

    def tearDown(self):
        agent.POWER_PENDING_FILE = self.saved[0]
        agent.power_state.clear()
        agent.power_state.update(self.saved[1])
        self.tmp.cleanup()

    def test_the_warning_runs_five_minutes_before_the_shutdown(self):
        now = [1000.0]
        agent.begin_switch_off(FRIDAY.replace(hour=18), clock=lambda: now[0])
        self.assertEqual(agent.power_off_screen(), {"at": int((1000 + 300) * 1000), "postponed": False})
        calls = []
        step = lambda: agent.power_off_step(clock=lambda: now[0], blocked=lambda: False,
                                            arm=lambda: calls.append("arm"), poweroff=lambda: calls.append("off"))
        self.assertEqual(step(), "waiting")
        now[0] += 299
        self.assertEqual(step(), "waiting")
        now[0] += 1
        self.assertEqual(step(), "off")
        self.assertEqual(calls, ["arm", "off"], "the wake alarm is set before the machine goes off")

    def test_an_installing_update_postpones_the_shutdown_and_survives_its_restart(self):
        now = [1000.0]
        event = FRIDAY.replace(hour=18)
        agent.begin_switch_off(event, clock=lambda: now[0])
        calls = []
        blocked = [True]

        def step():
            return agent.power_off_step(clock=lambda: now[0], blocked=lambda: blocked[0],
                                        arm=lambda: calls.append("arm"), poweroff=lambda: calls.append("off"))

        now[0] += agent.POWER_WARNING_SECONDS
        self.assertEqual(step(), "postponed")
        self.assertTrue(agent.power_off_screen()["postponed"])
        with open(agent.POWER_PENDING_FILE, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), {"event": agent.local_epoch(event)})
        self.assertEqual(step(), "waiting", "it looks again after POWER_POSTPONE_SECONDS, not at once")
        now[0] += agent.POWER_POSTPONE_SECONDS
        self.assertEqual(step(), "postponed")
        self.assertEqual(calls, [], "never shut down while an update installs")
        blocked[0] = False
        now[0] += agent.POWER_POSTPONE_SECONDS
        self.assertEqual(step(), "off")
        self.assertEqual(calls, ["arm", "off"])
        self.assertFalse(os.path.exists(agent.POWER_PENDING_FILE))

    def test_a_schedule_change_calls_off_the_shutdown_under_way(self):
        agent.begin_switch_off(FRIDAY.replace(hour=18), clock=lambda: 0.0)
        agent.apply_power_schedule({"week": [None, None, None, None, None, {"off": 18 * 60, "on": 7 * 60}, None]})
        self.assertIsNotNone(agent.power_off_screen(), "the same switch-off stays")
        agent.apply_power_schedule({"week": [None, None, None, None, None, {"off": 19 * 60, "on": None}, None]})
        self.assertIsNone(agent.power_off_screen())
        self.assertIsNone(agent.power_off_step(clock=lambda: 10_000.0, blocked=lambda: False,
                                               arm=self.fail, poweroff=self.fail))
        agent.begin_switch_off(FRIDAY.replace(hour=19), clock=lambda: 0.0)
        agent.apply_power_schedule(None)
        self.assertIsNone(agent.power_off_screen(), "no schedule at all calls it off too")

    def test_a_held_back_shutdown_is_taken_up_after_a_restart_only_when_recent(self):
        now = int(time.time())
        path = agent.POWER_PENDING_FILE
        for event, expected in ((now - 60, now - 60), (now - agent.POWER_PENDING_MAX_AGE_SECONDS - 1, None),
                                (now + 600, None), ("soon", None), (True, None)):
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"event": event}, handle)
            self.assertEqual(agent.take_power_pending(now, path), expected, event)
            self.assertFalse(os.path.exists(path), "the file is removed either way")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        self.assertIsNone(agent.take_power_pending(now, path))
        self.assertFalse(os.path.exists(path))
        self.assertIsNone(agent.take_power_pending(now, path))

    def test_what_counts_as_an_update_installing(self):
        saved = agent.is_live_session
        agent.is_live_session = lambda: False
        try:
            self.assertTrue(agent.update_blocks_shutdown(installing=True, report={}, units_active=False))
            self.assertTrue(agent.update_blocks_shutdown(installing=False, report={"phase": "installing"}, units_active=False))
            self.assertTrue(agent.update_blocks_shutdown(installing=False, report={"phase": "ready"}, units_active=True))
            self.assertFalse(agent.update_blocks_shutdown(installing=False, report={"phase": "ready"}, units_active=False))
            agent.is_live_session = lambda: True
            self.assertFalse(agent.update_blocks_shutdown(installing=True, report={}, units_active=True),
                             "a live session installs no updates")
        finally:
            agent.is_live_session = saved


class WakeAlarm(unittest.TestCase):
    def setUp(self):
        self.saved = (agent.run_wake_alarm_helper, agent.report_power_problem, agent.power_state["week"])
        self.runs, self.reports = [], []
        self.code = 0
        agent.run_wake_alarm_helper = lambda args: (self.runs.append(args), (self.code, "message"))[1]
        agent.report_power_problem = lambda problem, wake_at, detail: self.reports.append((problem, wake_at))

    def tearDown(self):
        agent.run_wake_alarm_helper, agent.report_power_problem, agent.power_state["week"] = self.saved

    def test_the_alarm_is_set_for_the_next_switch_on(self):
        agent.power_state["week"] = week_with(mon=(18 * 60, 7 * 60 + 30))
        self.assertEqual(agent.prepare_wake_alarm(FRIDAY.replace(hour=18)), "armed")
        monday = datetime(2026, 10, 26, 7, 30)
        self.assertEqual(self.runs, [["set", str(agent.local_epoch(monday))]])
        self.assertEqual(self.reports, [])

    def test_a_machine_without_an_rtc_is_reported(self):
        agent.power_state["week"] = week_with(mon=(18 * 60, 7 * 60 + 30))
        self.code = agent.WAKE_ALARM_EXIT_NO_RTC
        self.assertEqual(agent.prepare_wake_alarm(FRIDAY.replace(hour=18)), "no-rtc")
        self.assertEqual(self.reports, [("no-rtc", datetime(2026, 10, 26, 7, 30))])
        self.code = helper.EXIT_RTC_FAILED
        self.assertEqual(agent.prepare_wake_alarm(FRIDAY.replace(hour=18)), "failed")

    def test_with_no_switch_on_an_old_alarm_is_cleared(self):
        agent.power_state["week"] = week_with(fri=(18 * 60, None))
        self.assertIsNone(agent.prepare_wake_alarm(FRIDAY.replace(hour=18)))
        self.assertEqual(self.runs, [["clear"]])
        self.assertEqual(self.reports, [])

    def test_a_switch_on_too_close_to_set_is_skipped_for_the_next(self):
        agent.power_state["week"] = week_with(fri=(18 * 60, 18 * 60 + 1))
        agent.prepare_wake_alarm(FRIDAY.replace(hour=18))
        self.assertEqual(self.runs, [["set", str(agent.local_epoch(FRIDAY.replace(hour=18, minute=1) + timedelta(days=7)))]])

    def test_only_the_problems_the_console_accepts_are_reported(self):
        ts = read(POWER_TS)
        match = re.search(r"WAKE_ALARM_PROBLEMS = \[([^\]]*)\]", ts)
        self.assertEqual(tuple(re.findall(r'"([^"]+)"', match.group(1))), agent.POWER_PROBLEMS)
        with self.assertRaises(ValueError):
            self.saved[1]("asleep", FRIDAY, "")

    def test_the_warning_and_the_mac_limit_match_the_control_plane(self):
        ts = read(POWER_TS)
        minutes = int(re.search(r"POWER_WARNING_MINUTES = (\d+);", ts).group(1))
        self.assertEqual(agent.POWER_WARNING_SECONDS, minutes * 60)
        self.assertEqual(agent.MAX_WAKE_MACS, int(re.search(r"MAX_WAKE_MACS_PER_COMMAND = (\d+);", ts).group(1)))


class WakeAlarmHelper(unittest.TestCase):
    NOW = 1_800_000_000

    def test_only_a_plain_epoch_within_the_window_is_accepted(self):
        good = str(self.NOW + 3600)
        self.assertEqual(helper.parse_epoch(good, self.NOW), self.NOW + 3600)
        self.assertEqual(helper.parse_epoch(str(self.NOW + helper.MAX_LEAD_SECONDS), self.NOW),
                         self.NOW + helper.MAX_LEAD_SECONDS)
        for bad in (good + "\n", " " + good, "+" + good, "-1", "1.8e9", "0x6b49d200", good + ";reboot",
                    "", "12345678", "123456789012", str(self.NOW + 59),
                    str(self.NOW + helper.MAX_LEAD_SECONDS + 1), str(self.NOW - 3600), "١٨٠٠٠٠٣٦٠٠"):
            with self.assertRaises(helper.Refused, msg=repr(bad)):
                helper.parse_epoch(bad, self.NOW)

    def test_the_alarm_is_cleared_written_and_read_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "wakealarm")
            with open(path, "w", encoding="ascii"):
                pass
            writes = []
            real_write = helper.write_alarm

            def record(value, target=path):
                writes.append(value)
                real_write(value, target)

            helper.write_alarm = record
            try:
                helper.arm(self.NOW + 3600, False, path)
            finally:
                helper.write_alarm = real_write
            self.assertEqual(writes, [0, self.NOW + 3600])
            self.assertEqual(helper.read_alarm(path), self.NOW + 3600)

    def test_an_alarm_the_rtc_did_not_keep_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "wakealarm")
            with open(path, "w", encoding="ascii"):
                pass
            real_write = helper.write_alarm
            helper.write_alarm = lambda value, target=path: None
            try:
                with self.assertRaises(OSError):
                    helper.arm(self.NOW + 3600, False, path)
            finally:
                helper.write_alarm = real_write

    def test_no_rtc_is_its_own_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(helper.NoRtc):
                helper.write_alarm(0, os.path.join(tmp, "missing"))
            # A symbolic link is never followed.
            target = os.path.join(tmp, "elsewhere")
            with open(target, "w", encoding="ascii"):
                pass
            link = os.path.join(tmp, "wakealarm")
            os.symlink(target, link)
            with self.assertRaises(OSError):
                helper.write_alarm(0, link)

    def test_a_local_time_rtc_is_moved_by_the_local_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            adjtime = os.path.join(tmp, "adjtime")
            with open(adjtime, "w", encoding="ascii") as handle:
                handle.write("0.0 0 0.0\n0\nLOCAL\n")
            self.assertTrue(helper.rtc_keeps_local_time(adjtime))
            with open(adjtime, "w", encoding="ascii") as handle:
                handle.write("0.0 0 0.0\n0\nUTC\n")
            self.assertFalse(helper.rtc_keeps_local_time(adjtime))
            self.assertFalse(helper.rtc_keeps_local_time(os.path.join(tmp, "missing")))
        when = self.NOW + 3600
        self.assertEqual(helper.rtc_value(when, False), when)
        self.assertEqual(helper.rtc_value(when, True), when + time.localtime(when).tm_gmtoff)

    def test_anything_but_set_or_clear_is_refused(self):
        for argv in ([], ["set"], ["set", "soon"], ["set", "1", "2"], ["reboot"], ["clear", "now"]):
            self.assertEqual(helper.main(argv), helper.EXIT_REFUSED, argv)

    def test_the_helper_runs_as_root_through_one_sudoers_entry(self):
        hook = read(HOOK)
        self.assertIn("chmod 0755 /usr/local/sbin/labkiosk-wake-alarm\n", hook)
        self.assertIn("cat << 'EOF' > /etc/sudoers.d/52-labkiosk-wake-alarm\n"
                      "kiosk ALL=(ALL) NOPASSWD: /usr/local/sbin/labkiosk-wake-alarm\nEOF\n", hook)
        self.assertIn("chmod 0440 /etc/sudoers.d/52-labkiosk-wake-alarm\n", hook)
        self.assertEqual(agent.WAKE_ALARM_HELPER, "/usr/local/sbin/labkiosk-wake-alarm")
        self.assertIn('["sudo", "-n", WAKE_ALARM_HELPER, *args]', read(AGENT_PATH))
        self.assertTrue(os.stat(HELPER_PATH).st_mode & stat.S_IXUSR, "the helper is executable in the tree")
        self.assertEqual(read(HELPER_PATH).splitlines()[0], "#!/usr/bin/env python3")
        tracked = subprocess.run(["git", "-C", REPO, "ls-files", "-s", HELPER_PATH],
                                 capture_output=True, text=True, check=False).stdout
        if tracked:
            self.assertTrue(tracked.startswith("100755 "), tracked)

    def test_the_helpers_patterns_anchor_with_backslash_z(self):
        source = read(HELPER_PATH)
        patterns = re.findall(r're\.compile\(r"([^"]*)"\)', source)
        self.assertTrue(patterns)
        for pattern in patterns:
            self.assertTrue(pattern.endswith(r"\Z"), pattern)
            self.assertNotIn(r"\\Z", pattern)
            self.assertNotIn("$", pattern)

    def test_the_agent_profile_covers_what_the_power_code_touches(self):
        profile = read(CHROOT, "etc/apparmor.d/labkiosk-agent")
        for rule in ("owner /etc/labkiosk/** rwk,", "network inet dgram,", "/usr/bin/sudo Ux,", "/usr/bin/ip ix,"):
            self.assertIn(rule, profile)
        self.assertTrue(agent.POWER_PENDING_FILE.startswith("/etc/labkiosk/"))


class WakeOnLan(unittest.TestCase):
    def test_the_magic_packet_is_six_ff_then_the_address_sixteen_times(self):
        packet = agent.magic_packet("aa:bb:cc:dd:ee:0f")
        self.assertEqual(len(packet), 102)
        self.assertEqual(packet[:6], b"\xff" * 6)
        self.assertEqual(packet[6:], bytes([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x0F]) * 16)
        for bad in ("aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:0f\n", "AA:BB:CC:DD:EE:0F", "aa-bb-cc-dd-ee-0f", ""):
            with self.assertRaises(ValueError, msg=repr(bad)):
                agent.magic_packet(bad)

    def test_only_usable_unicast_addresses_are_woken(self):
        raw = ["AA:BB:CC:DD:EE:01", "aa:bb:cc:dd:ee:01", "01:00:5e:00:00:01", "ff:ff:ff:ff:ff:ff",
               "00:00:00:00:00:00", "aa:bb:cc:dd:ee:02\n", 42, None, "aa:bb:cc:dd:ee:03"]
        self.assertEqual(agent.wakeable_macs(raw), ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:03"])
        self.assertEqual(agent.wakeable_macs("aa:bb:cc:dd:ee:01"), [])
        many = ["02:00:00:00:%02x:%02x" % (i // 256, i % 256) for i in range(200)]
        self.assertEqual(len(agent.wakeable_macs(many)), agent.MAX_WAKE_MACS)

    def test_packets_are_broadcast_on_port_9_from_each_wired_network(self):
        sockets = []

        class FakeSocket:
            def __init__(self):
                self.options, self.bound, self.sent = [], None, []
                sockets.append(self)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def setsockopt(self, *args):
                self.options.append(args)

            def bind(self, address):
                self.bound = address

            def sendto(self, data, address):
                self.sent.append((data, address))

        networks = [("192.168.1.20", "192.168.1.255"), ("10.0.0.7", "10.0.0.255")]
        sent = agent.send_magic_packets(["aa:bb:cc:dd:ee:01", "AA:BB:CC:DD:EE:02"], networks, FakeSocket)
        self.assertEqual(sent, 4)
        self.assertEqual([s.bound for s in sockets], [("192.168.1.20", 0), ("10.0.0.7", 0)])
        for sock, (_local, broadcast) in zip(sockets, networks):
            self.assertIn((socket.SOL_SOCKET, socket.SO_BROADCAST, 1), sock.options)
            self.assertEqual(len(sock.sent), 2 * agent.WOL_REPEATS)
            self.assertEqual({address for _data, address in sock.sent}, {(broadcast, 9)})
            self.assertEqual({data for data, _address in sock.sent},
                             {agent.magic_packet("aa:bb:cc:dd:ee:01"), agent.magic_packet("aa:bb:cc:dd:ee:02")})

    def test_nothing_is_sent_without_an_address_or_a_network(self):
        opened = []
        self.assertEqual(agent.send_magic_packets(["01:00:5e:00:00:01"], [("192.168.1.2", "192.168.1.255")],
                                                  lambda: opened.append(1)), 0)
        self.assertEqual(agent.send_magic_packets(["aa:bb:cc:dd:ee:01"], [], lambda: opened.append(1)), 0)
        self.assertEqual(opened, [])

    def test_a_network_that_fails_does_not_stop_the_others(self):
        class Broken:
            def __enter__(self):
                raise OSError("no such device")

            def __exit__(self, *exc):
                return False

        self.assertEqual(agent.send_magic_packets(["aa:bb:cc:dd:ee:01"], [("192.168.1.2", "192.168.1.255")], Broken), 0)

    def test_wake_on_lan_is_armed_on_the_adapters_at_boot(self):
        link = read(CHROOT, "etc/systemd/network/99-default.link.d/labkiosk-wake-on-lan.conf")
        self.assertIn("[Link]\nWakeOnLan=magic\n", link)
        nm = read(CHROOT, "etc/NetworkManager/conf.d/50-labkiosk-wake-on-lan.conf")
        self.assertIn("[connection]\nethernet.wake-on-lan=magic\n", nm)


class KioskBar(unittest.TestCase):
    def test_the_bar_shows_the_switch_off_from_the_agents_status(self):
        content = read(CHROOT, "opt/labkiosk/extension/content.js")
        self.assertIn('id="power-notice"', content)
        self.assertIn("showPowerNotice(shadowRoot, data.powerOff)", content)
        self.assertIn('"powerOff": power_off', read(AGENT_PATH))
        catalog = json.loads(read(CHROOT, "opt/labkiosk/i18n/en-US.json"))
        for key in ("bar.power-off-title", "bar.power-off-text", "bar.power-off-postponed", "bar.power-off-now"):
            self.assertIn(key, catalog)
            self.assertIn(key, content)


if __name__ == "__main__":
    unittest.main()
