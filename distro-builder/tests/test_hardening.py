#!/usr/bin/env python3
"""
The firewall, the clock, the kiosk user's rights, the session, AppArmor, disk
health and fonts.

Nothing on the network gets an answer (/etc/nftables.conf); the clock follows
the network's own time servers (NetworkManager's dispatcher); the kiosk user
is in no group that writes to every terminal and has no polkit rights beyond
the ones granted by name; X is started by that user from a logind session, so
it runs without root wherever the graphics allow; the agent and x11vnc have
AppArmor profiles in complain mode; labkiosk-health reads the disks' wear and
the agent reports a disk wearing out. These tests drive the parts that run
without root and pin the image configuration the rest depends on. The VM boot
test (tests/vm/boot-test.sh) boots the real thing.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROOT = os.path.join(ROOT, "config", "includes.chroot")
HOOK = os.path.join(ROOT, "config/hooks/live/01-lockdown.hook.chroot")
DISPATCHER = os.path.join(CHROOT, "etc/NetworkManager/dispatcher.d/50-labkiosk-ntp")
HEALTH_PATH = os.path.join(CHROOT, "usr/local/sbin/labkiosk-health")


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


health = load("labkiosk_health", HEALTH_PATH)
agent = load("labkiosk_agent_hardening", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))


class Firewall(unittest.TestCase):
    def setUp(self):
        self.rules = read(CHROOT, "etc/nftables.conf")

    def test_everything_that_arrives_is_dropped_but_replies_and_the_network_basics(self):
        self.assertIn("type filter hook input priority filter; policy drop;", self.rules)
        self.assertIn("type filter hook forward priority filter; policy drop;", self.rules)
        for rule in ('iif "lo" accept', "ct state established,related accept", "ct state invalid drop",
                     "udp sport 67 udp dport 68 accept", "udp sport 547 udp dport 546 accept",
                     "nd-neighbor-solicit", "nd-neighbor-advert", "nd-router-advert"):
            self.assertIn(rule, self.rules)
        # The only port open to the LAN is the update-sharing one, and only from
        # private addresses.
        ports = re.findall(r"dport (\d+)", self.rules)
        self.assertEqual(sorted(set(ports)), ["546", "68", "8890"])
        self.assertNotIn("output", self.rules, "outgoing traffic is the browser policy's business")

    def test_a_reload_keeps_the_sharing_table(self):
        statements = "\n".join(line.split("#")[0] for line in self.rules.splitlines())
        self.assertNotIn("flush", statements)
        self.assertIn("delete table inet labkiosk_firewall", self.rules)

    def test_the_build_loads_it_and_refuses_another_file(self):
        hook = read(HOOK)
        self.assertIn("systemctl enable nftables.service", hook)
        self.assertIn("grep -q '^table inet labkiosk_firewall {' /etc/nftables.conf", hook)
        self.assertIn("nftables", package_list())

    @unittest.skipUnless(shutil.which("nft"), "needs nft to check the rules")
    def test_the_rules_parse(self):
        check = ["nft", "-c", "-f", os.path.join(CHROOT, "etc/nftables.conf")]
        ways = [check] if os.geteuid() == 0 else [["unshare", "-rn", *check], ["sudo", "-n", *check]]
        for command in ways:
            if not shutil.which(command[0]):
                continue
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            if result.returncode == 0:
                return
            if "Operation not permitted" not in result.stderr and "password is required" not in result.stderr:
                self.fail(f"{' '.join(command[:-1])} rejects the rules: {result.stderr}")
        self.skipTest("no way to open netlink here")


class NetworkTimeServers(unittest.TestCase):
    """The dispatcher, run with a stand-in systemctl and its drop-ins in a temporary folder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "timesyncd.conf.d")
        bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(bin_dir)
        self.calls = os.path.join(self.tmp.name, "calls")
        systemctl = os.path.join(bin_dir, "systemctl")
        with open(systemctl, "w", encoding="utf-8") as handle:
            handle.write(f'#!/bin/sh\necho "$*" >> {self.calls}\n')
        os.chmod(systemctl, 0o755)
        script = read(DISPATCHER)
        self.assertEqual(script.count("DIR=/run/systemd/timesyncd.conf.d\n"), 1)
        self.script = os.path.join(self.tmp.name, "dispatcher")
        with open(self.script, "w", encoding="utf-8") as handle:
            handle.write(script.replace("DIR=/run/systemd/timesyncd.conf.d\n", f"DIR={self.dir}\n"))
        os.chmod(self.script, 0o755)
        self.env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}")

    def run_dispatcher(self, iface, action, servers=None):
        env = dict(self.env)
        if servers is not None:
            env["DHCP4_NTP_SERVERS"] = servers
        result = subprocess.run([self.script, iface, action], env=env, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def files(self):
        return sorted(os.listdir(self.dir)) if os.path.isdir(self.dir) else []

    def restarts(self):
        return read(self.calls).splitlines() if os.path.exists(self.calls) else []

    def test_the_network_s_servers_are_used_and_anything_else_is_ignored(self):
        result = self.run_dispatcher("eth0", "up", "10.0.0.5 999.1.1.1 192.168.1.1;reboot 172.16.0.1")
        self.assertEqual(self.files(), ["network-dhcp-eth0.conf"])
        self.assertIn("[Time]\nNTP=10.0.0.5 172.16.0.1\n", read(self.dir, "network-dhcp-eth0.conf"))
        self.assertIn("999.1.1.1", result.stderr)
        self.assertEqual(self.restarts(), ["try-restart systemd-timesyncd.service"])

    def test_the_same_lease_again_restarts_nothing(self):
        self.run_dispatcher("eth0", "up", "10.0.0.5")
        self.run_dispatcher("eth0", "dhcp4-change", "10.0.0.5")
        self.assertEqual(len(self.restarts()), 1)

    def test_a_lease_without_servers_or_a_link_going_down_forgets_them(self):
        self.run_dispatcher("eth0", "up", "10.0.0.5")
        self.run_dispatcher("wlan0", "up", "10.0.0.6")
        self.run_dispatcher("eth0", "dhcp4-change", "")
        self.assertEqual(self.files(), ["network-dhcp-wlan0.conf"])
        self.run_dispatcher("wlan0", "down")
        self.assertEqual(self.files(), [])
        self.assertEqual(len(self.restarts()), 4)

    def test_an_interface_name_never_becomes_a_path(self):
        for name in ("../etc", "a/b", "", "x" * 16):
            self.run_dispatcher(name, "up", "10.0.0.5")
        self.assertEqual(self.files(), [])

    def test_the_wizard_s_server_comes_first(self):
        # timesyncd reads drop-ins in file-name order; labkiosk-localization's is
        # labkiosk.conf.
        self.assertLess("labkiosk.conf", "network-dhcp-eth0.conf")
        self.assertIn('TIMESYNCD_DROPIN = "/etc/systemd/timesyncd.conf.d/labkiosk.conf"',
                      read(CHROOT, "usr/local/sbin/labkiosk-localization"))

    def test_the_image_runs_it(self):
        hook = read(HOOK)
        self.assertIn("chmod 0755 /etc/NetworkManager/dispatcher.d/50-labkiosk-ntp", hook)
        self.assertIn("systemctl enable NetworkManager-dispatcher.service", hook)
        self.assertTrue(os.stat(DISPATCHER).st_mode & stat.S_IXUSR)


class ClockOnTheDiagnosticsPage(unittest.TestCase):
    def test_the_agent_says_whether_a_time_server_set_the_clock(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "synchronized")
            self.assertFalse(agent.clock_synchronized(marker))
            open(marker, "w", encoding="utf-8").close()
            self.assertTrue(agent.clock_synchronized(marker))
        self.assertIn('"clockSynchronized": clock_synchronized()', read(CHROOT, "opt/labkiosk/agent/agent.py"))
        wizard = read(CHROOT, "opt/labkiosk/setup/wizard.html")
        self.assertIn("data.clockSynchronized", wizard)
        catalog = json.loads(read(CHROOT, "opt/labkiosk/i18n/en-US.json"))
        for key in ("ui.js.clock", "ui.js.clock-synchronized", "ui.js.clock-not-synchronized"):
            self.assertIn(key, catalog)


class KioskUserRights(unittest.TestCase):
    def setUp(self):
        self.hook = read(HOOK)

    def test_the_kiosk_user_is_not_in_the_tty_group(self):
        for groups in re.findall(r"-G ([a-z,]+)", self.hook) + re.findall(r'LIVE_USER_DEFAULT_GROUPS="([a-z,]+)"', self.hook):
            self.assertNotIn("tty", groups.split(","), groups)
        self.assertIn('gpasswd -d "$KIOSK_USER" tty', self.hook)

    def test_polkit_grants_the_kiosk_user_nothing_beyond_its_named_rules(self):
        self.assertIn("/etc/polkit-1/rules.d/99-labkiosk-deny.rules", self.hook)
        rule = self.hook.split("/etc/polkit-1/rules.d/99-labkiosk-deny.rules", 1)[1].split("\nEOF\n", 1)[0]
        self.assertIn('if (subject.user !== "kiosk")', rule)
        self.assertIn("return polkit.Result.NO;", rule)
        self.assertNotIn("Result.YES", rule)
        # Every grant sorts before it, so polkit reaches the deny last.
        for name in re.findall(r"/etc/polkit-1/rules\.d/([0-9]{2}-[a-z-]+\.rules)", self.hook):
            self.assertLessEqual(name, "99-labkiosk-deny.rules")


class KioskSession(unittest.TestCase):
    def setUp(self):
        self.hook = read(HOOK)
        self.unit = read(CHROOT, "etc/systemd/system/labkiosk-session.service")

    def test_the_kiosk_user_starts_x_from_a_logind_session_on_tty7(self):
        for line in ("User=kiosk", "PAMName=labkiosk-session", "TTYPath=/dev/tty7", "StandardInput=tty-fail",
                     "UtmpIdentifier=tty7", "Restart=always", "StartLimitIntervalSec=0",
                     "Alias=display-manager.service", "WantedBy=graphical.target"):
            self.assertIn(line + "\n", self.unit)
        exec_start = re.search(r"^ExecStart=(.*)$", self.unit, re.MULTILINE).group(1).split()
        self.assertEqual(exec_start[:3], ["/usr/bin/xinit", "/home/kiosk/.xsession", "--"])
        self.assertEqual(exec_start[3:6], ["/usr/bin/Xorg", ":0", "vt7"])
        self.assertIn("-keeptty", exec_start)
        self.assertIn("-nolisten", exec_start)

    def test_the_pam_stack_registers_the_session_and_changes_no_password(self):
        stack = self.hook.split("cat << 'EOF' > /etc/pam.d/labkiosk-session\n", 1)[1].split("\nEOF\n", 1)[0]
        self.assertEqual(stack.splitlines(), [
            "#%PAM-1.0",
            "auth     required   pam_permit.so",
            "account  required   pam_permit.so",
            "password required   pam_deny.so",
            "session  required   pam_systemd.so class=user type=x11",
        ])

    def test_xorg_keeps_root_only_where_it_must(self):
        wrapper = self.hook.split("cat << 'EOF' > /etc/X11/Xwrapper.config\n", 1)[1].split("\nEOF\n", 1)[0]
        self.assertEqual(wrapper.splitlines(), ["allowed_users=console", "needs_root_rights=auto"])
        self.assertIn("\nchmod u+s /usr/lib/xorg/Xorg.wrap\n", self.hook)

    def test_nodm_is_gone(self):
        packages = package_list()
        self.assertNotIn("nodm", packages)
        self.assertTrue({"xinit", "libpam-systemd", "xserver-xorg-legacy"} <= packages)
        self.assertIn("systemctl enable labkiosk-session.service", self.hook)
        self.assertIn("systemctl set-default graphical.target", self.hook)
        self.assertNotIn("nodm.service", self.hook)
        units = os.path.join(CHROOT, "etc/systemd/system")
        for name in os.listdir(units):
            self.assertNotIn("nodm.service", read(units, name), name)


class AppArmor(unittest.TestCase):
    PROFILES = {
        "labkiosk-agent": "profile labkiosk-agent /opt/labkiosk/agent/agent.py flags=(complain) {",
        "labkiosk-x11vnc": "profile labkiosk-x11vnc /usr/bin/x11vnc flags=(complain) {",
    }

    def test_the_profiles_attach_to_the_agent_and_x11vnc_in_complain_mode(self):
        for name, header in self.PROFILES.items():
            self.assertIn(header, read(CHROOT, "etc/apparmor.d", name))

    def test_the_session_runs_the_agent_by_its_path(self):
        autostart = read(CHROOT, "etc/openbox/autostart")
        self.assertIn("\n    /opt/labkiosk/agent/agent.py >>/tmp/lab-agent.log 2>&1\n", autostart)
        self.assertNotIn("python3 /opt/labkiosk/agent/agent.py", autostart)
        self.assertTrue(read(CHROOT, "opt/labkiosk/agent/agent.py").startswith("#!/usr/bin/env python3\n"))
        hook = read(HOOK)
        self.assertIn("\nchmod 0755 /opt/labkiosk/agent/agent.py\n", hook)
        self.assertIn("apparmor", package_list())

    def test_the_profiles_are_loaded_on_a_live_system(self):
        # Debian's apparmor.service skips a live system, and the kiosk always is one.
        unit = read(CHROOT, "etc/systemd/system/labkiosk-apparmor.service")
        self.assertIn("\nExecStart=/sbin/apparmor_parser --replace "
                      "/etc/apparmor.d/labkiosk-agent /etc/apparmor.d/labkiosk-x11vnc\n", unit)
        self.assertIn("\nBefore=sysinit.target labkiosk-session.service\n", unit)
        self.assertNotIn("\nConditionPathExists", unit)
        self.assertIn("\nsystemctl enable labkiosk-apparmor.service\n", read(HOOK))

    @unittest.skipUnless(shutil.which("apparmor_parser") and os.path.isdir("/etc/apparmor.d/abstractions"),
                         "needs apparmor_parser and the abstractions to parse the profiles")
    def test_the_profiles_parse(self):
        for name in self.PROFILES:
            result = subprocess.run(
                ["apparmor_parser", "--skip-kernel-load", "--skip-cache", "-I", "/etc/apparmor.d",
                 os.path.join(CHROOT, "etc/apparmor.d", name)],
                capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)


class DiskHealth(unittest.TestCase):
    def nvme(self, **health):
        log = {"critical_warning": 0, "available_spare": 100, "available_spare_threshold": 10,
               "percentage_used": 3, "media_errors": 0, **health}
        return {"model_name": "Example SSD", "serial_number": "S1",
                "smart_status": {"passed": True}, "nvme_smart_health_information_log": log}

    def ata(self, attributes=(), wear=None, passed=True):
        report = {"model_name": "Example SATA", "serial_number": "A1", "smart_status": {"passed": passed},
                  "ata_smart_attributes": {"table": [{"id": i, "raw": {"value": v}} for i, v in attributes]}}
        if wear is not None:
            report["ata_device_statistics"] = {"pages": [{"number": 7, "table": [
                {"name": "Percentage Used Endurance Indicator", "value": wear}]}]}
        return report

    def test_a_healthy_nvme_disk_says_how_worn_it_is(self):
        result = health.assess_smart("nvme0n1", self.nvme(), 0)
        self.assertEqual(result, {"device": "nvme0n1", "model": "Example SSD", "serial": "S1",
                                  "state": "ok", "summary": "Healthy. 3% of its rated life used."})

    def test_nvme_wear_and_errors_are_warnings_and_its_own_alarms_are_failures(self):
        self.assertEqual(health.assess_smart("nvme0n1", self.nvme(percentage_used=93), 0)["state"], "warning")
        self.assertEqual(health.assess_smart("nvme0n1", self.nvme(media_errors=2), 0)["state"], "warning")
        failing = health.assess_smart("nvme0n1", self.nvme(critical_warning=4), 0)
        self.assertEqual(failing["state"], "failing")
        self.assertIn("critical warning", failing["summary"])
        spare = health.assess_smart("nvme0n1", self.nvme(available_spare=5), 0)
        self.assertEqual(spare["state"], "failing")

    def test_ata_reallocated_sectors_and_wear_are_warnings(self):
        self.assertEqual(health.assess_smart("sda", self.ata(), 0)["state"], "ok")
        worn = health.assess_smart("sda", self.ata(attributes=[(5, 12), (197, 0)]), 0)
        self.assertEqual(worn["state"], "warning")
        self.assertEqual(worn["summary"], "Wearing out: 12 reallocated sectors.")
        self.assertEqual(health.assess_smart("sda", self.ata(wear=95), 0)["state"], "warning")
        self.assertEqual(health.assess_smart("sda", self.ata(passed=False), health.SMART_DISK_FAILING)["state"],
                         "failing")

    def test_a_disk_without_health_data_is_unknown_not_a_problem(self):
        self.assertEqual(health.assess_smart("vda", {}, health.SMART_COULD_NOT_OPEN)["state"], "unknown")
        self.assertEqual(health.assess_smart("vda", {"model_name": "QEMU"}, 4)["state"], "unknown")

    def test_text_from_the_disk_is_cleaned(self):
        report = self.nvme()
        report["model_name"] = "Evil\nModel\x07" + "x" * 300
        model = health.assess_smart("nvme0n1", report, 0)["model"]
        self.assertNotIn("\n", model)
        self.assertLessEqual(len(model), health.MAX_FIELD)

    def make_block(self, root, name, removable="0", usb=False, device=None):
        target = os.path.join(root, "devices", "usb1" if usb else "pci0", name)
        os.makedirs(target)
        with open(os.path.join(target, "removable"), "w", encoding="utf-8") as handle:
            handle.write(removable + "\n")
        if device:
            os.makedirs(os.path.join(target, "device"))
            for key, value in device.items():
                with open(os.path.join(target, "device", key), "w", encoding="utf-8") as handle:
                    handle.write(value + "\n")
        os.symlink(target, os.path.join(root, "block", name))

    def test_only_the_machine_s_own_disks_are_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "block"))
            for name in ("sda", "nvme0n1", "mmcblk0", "loop0", "zram0", "sr0", "sda1", "mmcblk0boot0"):
                self.make_block(tmp, name)
            self.make_block(tmp, "sdb", removable="1")
            self.make_block(tmp, "sdc", usb=True)
            self.assertEqual(health.disks(os.path.join(tmp, "block")), ["mmcblk0", "nvme0n1", "sda"])

    def test_a_disk_that_cannot_be_read_is_unknown_and_the_rest_are_still_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "block"))
            self.make_block(tmp, "mmcblk0", device={"name": "EMMC32", "life_time": "0x02 0x02", "pre_eol_info": "0x01"})
            self.make_block(tmp, "mmcblk1", device={"name": "BROKEN"})
            os.mkdir(os.path.join(tmp, "block", "mmcblk1", "device", "life_time"))  # Reading it fails.
            results = {disk["device"]: disk for disk in health.disk_health(os.path.join(tmp, "block"))}
            self.assertEqual(results["mmcblk0"]["state"], "ok")
            self.assertEqual(results["mmcblk1"]["state"], "unknown")
            self.assertIn("could not be read", results["mmcblk1"]["summary"])

    def test_emmc_wear_comes_from_the_card(self):
        cases = [("0x02 0x03", "0x01", "ok"), ("0x09 0x01", "0x01", "warning"), ("0x01 0x01", "0x02", "warning"),
                 ("0x0B 0x01", "0x01", "failing"), ("0x01 0x01", "0x03", "failing")]
        for life, eol, expected in cases:
            with tempfile.TemporaryDirectory() as tmp:
                os.makedirs(os.path.join(tmp, "block"))
                self.make_block(tmp, "mmcblk0", device={"name": "EMMC32", "serial": "0x1234",
                                                        "life_time": life, "pre_eol_info": eol})
                result = health.emmc_health("mmcblk0", os.path.join(tmp, "block"))
                self.assertEqual(result["state"], expected, (life, eol))
                self.assertEqual(result["model"], "EMMC32")
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "block"))
            self.make_block(tmp, "mmcblk0", device={"name": "OLD"})
            self.assertEqual(health.emmc_health("mmcblk0", os.path.join(tmp, "block"))["state"], "unknown")

    def test_the_report_is_world_readable_and_written_whole(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "health", "disks.json")
            health.write_report([{"device": "sda", "state": "ok"}], path)
            self.assertEqual(json.loads(read(path)), {"disks": [{"device": "sda", "state": "ok"}]})
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o644)
            self.assertEqual(os.listdir(os.path.dirname(path)), ["disks.json"])

    def test_the_image_runs_it_and_not_smartd(self):
        hook = read(HOOK)
        self.assertIn("systemctl enable labkiosk-health.timer", hook)
        self.assertIn("systemctl mask smartmontools.service", hook)
        self.assertIn("/usr/local/sbin/labkiosk-health", hook)
        self.assertIn("smartmontools", package_list())
        timer = read(CHROOT, "etc/systemd/system/labkiosk-health.timer")
        self.assertIn("OnBootSec=90s", timer)
        self.assertIn("OnUnitActiveSec=6h", timer)
        service = read(CHROOT, "etc/systemd/system/labkiosk-health.service")
        self.assertIn("ExecStart=/usr/local/sbin/labkiosk-health\n", service)
        self.assertIn("PrivateNetwork=yes", service)


class AgentReportsDiskHealth(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "disks.json")
        saved = {name: getattr(agent, name) for name in ("read_disk_problems", "post_disk_health", "log")}
        saved_state = dict(agent.state)

        def restore():
            for name, value in saved.items():
                setattr(agent, name, value)
            agent.state.clear()
            agent.state.update(saved_state)

        self.addCleanup(restore)
        agent.log = lambda message: None
        agent.state["isConfigured"] = True
        agent.read_disk_problems = lambda path: saved["read_disk_problems"](path, owner_uid=os.getuid())
        self.sent = []
        self.answers = []

        def post(problems):
            self.sent.append(problems)
            answer = self.answers.pop(0) if self.answers else 200
            if isinstance(answer, Exception):
                raise answer
            return answer

        agent.post_disk_health = post
        self.progress = {"checked": None, "logged": set()}

    def write(self, disks, mtime):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"disks": disks}, handle)
        os.utime(self.path, ns=(mtime, mtime))

    def disk(self, state, device="nvme0n1"):
        return {"device": device, "model": "Example", "serial": "S1", "state": state, "summary": f"{state}."}

    def test_only_problem_disks_are_sent_once_per_check(self):
        self.write([self.disk("ok", "sda"), self.disk("warning"), self.disk("unknown", "vda")], 1_000_000_000)
        agent.report_disk_health(self.progress, self.path)
        agent.report_disk_health(self.progress, self.path)
        self.assertEqual(self.sent, [[self.disk("warning")]])
        self.write([self.disk("warning")], 2_000_000_000)
        agent.report_disk_health(self.progress, self.path)
        self.assertEqual(len(self.sent), 2, "the next check sends again; the Worker lists it once")

    def test_healthy_disks_send_nothing(self):
        self.write([self.disk("ok")], 1_000_000_000)
        agent.report_disk_health(self.progress, self.path)
        self.assertEqual(self.sent, [])

    def test_offline_or_not_yet_known_is_tried_again(self):
        self.write([self.disk("failing")], 1_000_000_000)
        self.answers = [OSError("offline"), 409, 200]
        for _ in range(4):
            agent.report_disk_health(self.progress, self.path)
        self.assertEqual(len(self.sent), 3)

    def test_a_refused_or_held_report_waits_for_the_next_check(self):
        for answer in (400, 429):
            self.sent.clear()
            self.progress = {"checked": None, "logged": set()}
            self.write([self.disk("warning")], 1_000_000_000)
            self.answers = [answer]
            agent.report_disk_health(self.progress, self.path)
            agent.report_disk_health(self.progress, self.path)
            self.assertEqual(len(self.sent), 1, answer)

    def test_nothing_is_sent_before_enrolment_or_before_a_check(self):
        agent.report_disk_health(self.progress, self.path)
        agent.state["isConfigured"] = False
        self.write([self.disk("failing")], 1_000_000_000)
        agent.report_disk_health(self.progress, self.path)
        self.assertEqual(self.sent, [])

    def test_a_file_root_did_not_write_is_not_sent(self):
        self.write([self.disk("failing")], 1_000_000_000)
        with self.assertRaises(ValueError):
            agent.read_root_json(self.path, owner_uid=os.getuid() + 1, max_bytes=agent.MAX_DISK_HEALTH_BYTES)
        self.write([{"device": "sda", "state": "failing"}], 2_000_000_000)
        agent.report_disk_health(self.progress, self.path)
        self.assertEqual(self.sent, [], "a disk without its fields is not sent")


INTEL_VAINFO = """libva info: VA-API version 1.17.0
libva info: va_openDriver() returns 0
vainfo: VA-API version: 1.17 (libva 2.12.0)
vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 23.1.1 ()
vainfo: Supported profile and entrypoints
      VAProfileNone                   :\tVAEntrypointVideoProc
      VAProfileMPEG2Simple            :\tVAEntrypointVLD
      VAProfileH264Main               :\tVAEntrypointVLD
      VAProfileH264Main               :\tVAEntrypointEncSliceLP
      VAProfileH264High               :\tVAEntrypointVLD
      VAProfileHEVCMain10             :\tVAEntrypointVLD
      VAProfileVP9Profile0            :\tVAEntrypointVLD
      VAProfileAV1Profile0            :\tVAEntrypointVLD
      VAProfileJPEGBaseline           :\tVAEntrypointEncPicture
      VAProfileH264StereoHigh         :\tVAEntrypointFEI
"""


class AgentReportsVideoDecoding(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.drm = os.path.join(self.tmp.name, "drm")
        os.mkdir(self.drm)
        saved = {name: getattr(agent, name) for name in ("probe_video_decoding", "post_video_decoding", "log")}
        saved_state = dict(agent.state)

        def restore():
            for name, value in saved.items():
                setattr(agent, name, value)
            agent.state.clear()
            agent.state.update(saved_state)

        self.addCleanup(restore)
        self.logged = []
        agent.log = self.logged.append
        agent.state["isConfigured"] = True

    def gpu(self, node, vendor, driver):
        device = os.path.join(self.tmp.name, "devices", node)
        os.makedirs(os.path.join(self.tmp.name, "drivers", driver), exist_ok=True)
        os.makedirs(device)
        with open(os.path.join(device, "vendor"), "w", encoding="ascii") as handle:
            handle.write(vendor + "\n")
        os.symlink(os.path.join(self.tmp.name, "drivers", driver), os.path.join(device, "driver"))
        os.makedirs(os.path.join(self.drm, node))
        os.symlink(device, os.path.join(self.drm, node, "device"))

    def test_vainfo_output_becomes_codec_lists(self):
        self.assertEqual(agent.parse_vainfo(INTEL_VAINFO), {
            "vaDriver": "Intel iHD driver for Intel(R) Gen Graphics - 23.1.1 ()",
            "decode": ["av1", "h264", "hevc", "mpeg2", "vp9"],
            "encode": ["h264", "jpeg"],
        })

    def test_vainfo_without_a_driver_is_a_problem(self):
        with self.assertRaises(ValueError):
            agent.parse_vainfo("libva info: VA-API version 1.17.0\nlibva error: vaGetDriverNameByIndex() failed\n")

    def test_each_render_node_is_asked_and_named(self):
        self.gpu("renderD128", "0x8086", "i915")
        self.gpu("renderD129", "0x10de", "nouveau")
        os.makedirs(os.path.join(self.drm, "card0"))
        asked = []

        def vainfo(device):
            asked.append(device)
            if device.endswith("129"):
                raise ValueError("vaInitialize failed with error code -1 (unknown libva error),exit")
            return INTEL_VAINFO

        report = agent.probe_video_decoding(self.drm, vainfo)
        self.assertEqual(asked, ["/dev/dri/renderD128", "/dev/dri/renderD129"])
        intel, nvidia = report["gpus"]
        self.assertEqual((intel["vendor"], intel["kernelDriver"]), ("intel", "i915"))
        self.assertIn("av1", intel["decode"])
        self.assertNotIn("problem", intel)
        self.assertEqual((nvidia["vendor"], nvidia["kernelDriver"], nvidia["decode"]), ("nvidia", "nouveau", []))
        self.assertIn("vaInitialize failed", nvidia["problem"])

    def test_no_gpu_or_no_vainfo_says_why(self):
        report = agent.probe_video_decoding(self.drm, lambda device: INTEL_VAINFO)
        self.assertEqual(report, {"gpus": [], "problem": "No GPU render device (/dev/dri/renderD*)."})
        self.gpu("renderD128", "0x1af4", "virtio-pci")

        def missing(device):
            raise FileNotFoundError("vainfo")

        gpu = agent.probe_video_decoding(self.drm, missing)["gpus"][0]
        self.assertEqual((gpu["vendor"], gpu["problem"]), ("virtual", "vainfo is not installed."))

    def test_the_report_is_sent_until_the_control_plane_answers(self):
        probes = []
        agent.probe_video_decoding = lambda: probes.append(1) or {"gpus": [], "problem": "No GPU render device (/dev/dri/renderD*)."}
        answers = [OSError("offline"), 409, 200]
        sent = []

        def post(report):
            sent.append(report)
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        agent.post_video_decoding = post
        progress = {"report": None, "done": False, "logged": False}
        for _ in range(5):
            agent.report_video_decoding(progress)
        self.assertEqual(len(sent), 3)
        self.assertEqual(len(probes), 1, "the GPUs are read once per agent start")
        self.assertTrue(progress["done"])
        self.assertIn("Hardware video decoding: none, Chromium decodes on the CPU.", self.logged)

    def test_a_refused_report_is_not_sent_again_and_nothing_goes_before_enrolment(self):
        agent.probe_video_decoding = lambda: {"gpus": [], "problem": "No GPU render device (/dev/dri/renderD*)."}
        sent = []
        agent.post_video_decoding = lambda report: sent.append(report) or 400
        progress = {"report": None, "done": False, "logged": False}
        agent.state["isConfigured"] = False
        agent.report_video_decoding(progress)
        self.assertEqual(sent, [])
        agent.state["isConfigured"] = True
        agent.report_video_decoding(progress)
        agent.report_video_decoding(progress)
        self.assertEqual(len(sent), 1)

    def test_the_image_ships_vainfo_and_lets_the_agent_run_it(self):
        self.assertIn("vainfo", package_list())
        profile = read(CHROOT, "etc/apparmor.d/labkiosk-agent")
        self.assertIn("\n  /usr/bin/vainfo ix,\n", profile)
        self.assertIn("\n  /dev/dri/renderD* rw,\n", profile)


class AgentReportsHardware(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        saved = {name: getattr(agent, name) for name in ("probe_hardware", "post_device_json", "log")}
        saved_state = dict(agent.state)

        def restore():
            for name, value in saved.items():
                setattr(agent, name, value)
            agent.state.clear()
            agent.state.update(saved_state)

        self.addCleanup(restore)
        agent.log = lambda message: None
        agent.state["isConfigured"] = True

    def write(self, path, text):
        full = os.path.join(self.tmp.name, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as handle:
            handle.write(text)
        return full

    def adapter(self, name, mac, wireless=False, physical=True, kind="1"):
        self.write(f"net/{name}/address", mac + "\n")
        self.write(f"net/{name}/type", kind + "\n")
        if physical:
            os.makedirs(os.path.join(self.tmp.name, "net", name, "device"))
        if wireless:
            os.makedirs(os.path.join(self.tmp.name, "net", name, "wireless"))

    def test_the_machine_is_read_from_firmware_cpu_memory_and_wired_adapters(self):
        self.write("dmi/sys_vendor", "LENOVO\n")
        self.write("dmi/product_name", "10T7S0B500\n")
        self.write("dmi/product_version", "ThinkCentre M720q\n")
        cpuinfo = self.write("cpuinfo", "processor\t: 0\nmodel name\t: Intel(R) Core(TM) i5-8500T  CPU @ 2.10GHz\n")
        meminfo = self.write("meminfo", "MemTotal:        8040128 kB\nMemFree: 1 kB\n")
        self.adapter("enp1s0", "8C:16:45:AA:BB:CC")
        self.adapter("wlp2s0", "8c:16:45:00:00:01", wireless=True)
        self.adapter("docker0", "02:42:00:00:00:01", physical=False)
        self.adapter("lo", "00:00:00:00:00:00", physical=False, kind="772")
        os.makedirs(os.path.join(self.tmp.name, "efi"))
        report = agent.probe_hardware(
            os.path.join(self.tmp.name, "dmi"), os.path.join(self.tmp.name, "net"),
            os.path.join(self.tmp.name, "efi"), cpuinfo, meminfo,
        )
        self.assertEqual((report["vendor"], report["model"]), ("LENOVO", "ThinkCentre M720q"))
        self.assertEqual(report["cpu"], "Intel(R) Core(TM) i5-8500T CPU @ 2.10GHz")
        self.assertEqual((report["memoryMb"], report["bootMode"]), (7851, "uefi"))
        self.assertEqual(report["macs"], ["8c:16:45:aa:bb:cc"], "only the physical wired adapter")
        self.assertGreaterEqual(report["cores"], 1)

    def test_other_makers_name_the_model_in_product_name_and_bios_has_no_efi_directory(self):
        self.write("dmi/sys_vendor", "Dell Inc.\n")
        self.write("dmi/product_name", "OptiPlex 7050\n")
        self.write("dmi/product_version", "Not Specified\n")
        report = agent.probe_hardware(
            os.path.join(self.tmp.name, "dmi"), os.path.join(self.tmp.name, "net"),
            os.path.join(self.tmp.name, "efi"), os.path.join(self.tmp.name, "none"), os.path.join(self.tmp.name, "none"),
        )
        self.assertEqual((report["model"], report["bootMode"], report["macs"]), ("OptiPlex 7050", "bios", []))
        self.assertEqual(report["memoryMb"], 64, "an unreadable size is reported as the smallest the control plane takes")

    def test_the_report_is_sent_once_the_control_plane_answers(self):
        probes = []
        agent.probe_hardware = lambda: probes.append(1) or {
            "vendor": "", "model": "", "cpu": "", "cores": 2, "memoryMb": 2048, "bootMode": "bios",
            "keyboard": None, "touch": None, "macs": [],
        }
        answers = [OSError("offline"), 409, 200]
        sent = []

        def post(path, report):
            sent.append(path)
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        agent.post_device_json = post
        progress = {"report": None, "done": False, "logged": False}
        for _ in range(5):
            agent.report_hardware(progress)
        self.assertEqual(sent, ["/api/devices/hardware"] * 3)
        self.assertEqual(len(probes), 1)
        self.assertTrue(progress["done"])

    def test_the_agent_may_read_what_it_reports(self):
        profile = read(CHROOT, "etc/apparmor.d/labkiosk-agent")
        for rule in ("/sys/devices/virtual/dmi/id/product_name r,", "/sys/devices/**/net/*/address r,", "@{PROC}/meminfo r,"):
            self.assertIn(rule, profile)


class AgentCountsUsage(unittest.TestCase):
    def setUp(self):
        self.now = [1000.0]
        self.day = ["2026-10-20"]
        self.counter = agent.UsageCounter(clock=lambda: self.now[0], today=lambda: self.day[0])
        saved = {name: getattr(agent, name) for name in ("post_device_json", "log")}
        saved_state = dict(agent.state)

        def restore():
            for name, value in saved.items():
                setattr(agent, name, value)
            agent.state.clear()
            agent.state.update(saved_state)

        self.addCleanup(restore)
        agent.log = lambda message: None
        agent.state["isConfigured"] = True

    def advance(self, seconds):
        self.now[0] += seconds
        self.counter.count_on()

    def days(self):
        return {d["day"]: d for d in self.counter.take()}

    def test_only_real_hostnames_are_kept(self):
        self.assertEqual(agent.usage_host("Docs.Example.ORG."), "docs.example.org")
        for host in ("127.0.0.1", "localhost", "", "192.168.1.10", "bad host.org", None, "a" * 300 + ".org"):
            self.assertEqual(agent.usage_host(host), "")

    def test_each_tick_credits_the_minute_before_it_to_what_the_last_one_said(self):
        self.counter.set_record_sites(True)
        self.counter.tick("docs.example.org", True)
        self.advance(60)
        self.counter.tick("docs.example.org", False)
        self.advance(60)
        self.counter.tick("video.example.org", True)
        self.advance(600)  # asleep or switched off: only a bounded credit
        self.counter.tick("video.example.org", True)
        day = self.days()["2026-10-20"]
        self.assertEqual(day["activeSeconds"], 60 + agent.USAGE_TICK_MAX_CREDIT_SECONDS)
        self.assertEqual(day["onSeconds"], 60 + 60 + agent.USAGE_ON_MAX_CREDIT_SECONDS)
        self.assertEqual(day["sites"], [
            {"domain": "docs.example.org", "seconds": 60, "visits": 1},
            {"domain": "video.example.org", "seconds": agent.USAGE_TICK_MAX_CREDIT_SECONDS, "visits": 1},
        ])
        self.assertEqual(self.counter.take(), [], "taken once")

    def test_no_sites_unless_the_organization_records_them(self):
        self.counter.tick("docs.example.org", True)
        self.advance(60)
        self.counter.tick("docs.example.org", True)
        self.counter.session_started()
        day = self.days()["2026-10-20"]
        self.assertEqual((day["sites"], day["sessions"], day["activeSeconds"]), ([], 1, 60), "time in use is counted all the same")
        self.counter.set_record_sites(True)
        self.counter.tick("docs.example.org", True)
        self.counter.set_record_sites(False)
        self.assertEqual(self.counter.take(), [], "turning it off drops what was counted")

    def test_days_are_the_workstations_own_and_a_failed_report_is_kept(self):
        self.day[0] = "2020-01-01"
        self.counter.session_started()
        self.day[0] = time.strftime("%Y-%m-%d")
        self.counter.session_started()
        report = self.counter.take()
        self.assertEqual([d["day"] for d in report], [time.strftime("%Y-%m-%d")], "a day older than the control plane takes is dropped")
        self.counter.put_back(report)
        answers = [OSError("offline"), 503, 200]
        sent = []

        def post(path, payload):
            sent.append(payload)
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        agent.post_device_json = post
        for _ in range(4):
            agent.report_usage(self.counter)
        self.assertEqual(len(sent), 3, "nothing left to send after the 200")
        self.assertEqual(sent[-1]["days"][0]["sessions"], 1)

    def test_a_malformed_report_is_dropped_and_nothing_goes_before_enrolment(self):
        self.day[0] = time.strftime("%Y-%m-%d")
        self.counter.session_started()
        agent.state["isConfigured"] = False
        sent = []
        agent.post_device_json = lambda path, payload: sent.append(payload) or 400
        agent.report_usage(self.counter)
        self.assertEqual(sent, [])
        agent.state["isConfigured"] = True
        agent.report_usage(self.counter)
        agent.report_usage(self.counter)
        self.assertEqual(len(sent), 1)

    def test_the_extension_ticks_with_the_senders_address_and_the_idle_state(self):
        background = read(CHROOT, "opt/labkiosk/extension/background.js")
        self.assertIn("chrome.idle.queryState(USAGE_IDLE_SECONDS)", background)
        self.assertIn("sender.frameId !== 0", background)
        manifest = json.loads(read(CHROOT, "opt/labkiosk/extension/manifest.json"))
        self.assertIn("idle", manifest["permissions"])
        self.assertNotIn("tabs", manifest["permissions"])


class Fonts(unittest.TestCase):
    def test_chinese_japanese_and_korean_pages_have_fonts(self):
        self.assertIn("fonts-noto-cjk", package_list())


if __name__ == "__main__":
    unittest.main()
