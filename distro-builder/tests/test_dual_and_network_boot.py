#!/usr/bin/env python3
"""
Installing beside another system (dual boot), and starting over the network.

The installer's free-space arithmetic, its refusals and the firmware boot
entry it registers; the agent's install API and its network-boot enrolment;
the boot-server tool's layout. These run without root, a disk or a network:
the VM boot test (tests/vm/boot-test.sh, scenarios 11-14) installs beside a
real partition table and boots over UEFI HTTP, UEFI PXE and BIOS iPXE.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import importlib.machinery
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROOT = os.path.join(ROOT, "config", "includes.chroot")
INSTALLER_PATH = os.path.join(CHROOT, "usr/local/bin/labkiosk-install")
TOOL_PATH = os.path.join(ROOT, "tools", "labkiosk-netboot.py")

MIB = 1024 * 1024
GIB = 1024 * MIB
ESP = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
DIGEST = "grub.pbkdf2.sha512.10000." + "AB" * 32 + "." + "CD" * 64
KEY = "AAAAA-AAAAA-AAAAA-AAAAA"


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as handle:
        return handle.read()


installer = load("labkiosk_install_dual", INSTALLER_PATH)
agent = load("labkiosk_agent_dual", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))
tool = load("labkiosk_netboot", TOOL_PATH)
agent.log = lambda message: None
installer.write_status = lambda *args, **kwargs: None


def part(path, start_mib, size_mib, esp=False, fstype="ext4", label=""):
    return {"path": path, "start": start_mib * MIB, "size": size_mib * MIB, "esp": esp,
            "fstype": fstype, "label": label}


def shared_disk(size_gib=100, partitions=None):
    """A GPT disk with an ESP, another system's 40 GiB partition, then free space."""
    if partitions is None:
        partitions = [part("/dev/sda1", 1, 100, esp=True, fstype="vfat"),
                      part("/dev/sda2", 101, 40 * 1024)]
    return {"label": "gpt", "usable": (MIB, size_gib * GIB - MIB), "partitions": partitions}


class FreeSpace(unittest.TestCase):
    def test_gaps_are_whole_mib_inside_the_usable_area(self):
        layout = shared_disk()
        self.assertEqual(installer.free_regions(layout), [(101 + 40 * 1024, 100 * 1024 - 1)])

    def test_an_unaligned_partition_rounds_the_gap_inwards(self):
        layout = shared_disk(partitions=[{"path": "/dev/sda1", "start": MIB + 512, "size": 10 * MIB,
                                          "esp": True, "fstype": "", "label": ""}])
        self.assertEqual(installer.free_regions(layout)[0], (12, 100 * 1024 - 1))

    def test_a_replaced_partition_counts_as_free(self):
        layout = shared_disk()
        self.assertEqual(installer.free_regions(layout, without="/dev/sda2"), [(101, 100 * 1024 - 1)])

    def test_the_largest_stretch_is_chosen_and_must_hold_an_installation(self):
        layout = shared_disk()
        self.assertEqual(installer.beside_region(layout), (101 + 40 * 1024, 100 * 1024 - 1))
        small = shared_disk(size_gib=45)
        self.assertIsNone(installer.beside_region(small))

    def test_replacing_takes_the_partition_and_the_free_space_around_it(self):
        layout = shared_disk(size_gib=45)
        self.assertEqual(installer.beside_region(layout, layout["partitions"][1]), (101, 45 * 1024 - 1))

    def test_a_too_small_partition_cannot_be_replaced(self):
        layout = shared_disk(partitions=[part("/dev/sda1", 1, 100, esp=True),
                                         part("/dev/sda2", 101, 1024),
                                         part("/dev/sda3", 1125, 100 * 1024 - 1126)])
        self.assertIsNone(installer.beside_region(layout, layout["partitions"][1]))


class WhatTheWizardIsOffered(unittest.TestCase):
    def info(self, layout, uefi=True, busy=frozenset()):
        return installer.dual_boot_info(layout, uefi, busy)

    def test_free_space_and_replaceable_partitions_are_offered(self):
        info = self.info(shared_disk())
        self.assertTrue(info["possible"])
        self.assertIsNone(info["reason"])
        self.assertEqual(info["freeBytes"], (100 * 1024 - 1 - 101 - 40 * 1024) * MIB)
        by_path = {p["path"]: p for p in info["partitions"]}
        self.assertFalse(by_path["/dev/sda1"]["replaceable"], "the ESP is every system's")
        self.assertTrue(by_path["/dev/sda2"]["replaceable"])

    def test_a_partition_in_use_is_not_offered(self):
        info = self.info(shared_disk(size_gib=45), busy={"/dev/sda2"})
        self.assertFalse(info["possible"])
        self.assertIn("Shrink a partition", info["reason"])

    def test_each_reason_it_cannot_be_done(self):
        cases = (
            (dict(uefi=False), "legacy BIOS"),
            (dict(layout={"label": "dos", "usable": (MIB, 100 * GIB), "partitions": []}), "MBR"),
            (dict(layout={"label": "", "usable": (MIB, 100 * GIB), "partitions": []}), "no partition table"),
            (dict(layout=shared_disk(partitions=[part("/dev/sda1", 1, 1024)])), "no EFI system partition"),
        )
        for overrides, reason in cases:
            with self.subTest(reason=reason):
                kwargs = {"layout": shared_disk(), "uefi": True}
                kwargs.update(overrides)
                info = self.info(kwargs["layout"], kwargs["uefi"])
                self.assertFalse(info["possible"])
                self.assertIn(reason, info["reason"])

    def test_the_listing_never_fails_on_one_unreadable_disk(self):
        with mock.patch.object(installer, "read_layout_unprivileged", side_effect=RuntimeError("lsblk broke")):
            info = installer.describe_dual_boot("/dev/sda")
        self.assertFalse(info["possible"])
        self.assertIn("lsblk broke", info["reason"])


PARTED_GPT = """BYT;
/dev/sda:107374182400B:scsi:512:512:gpt:QEMU HARDDISK:;
1:1048576B:105906175B:104857600B:fat32:EFI system partition:boot, esp;
2:105906176B:43055579135B:42949672960B:ext4:other:;
"""


class ReadingThePartitionTable(unittest.TestCase):
    def test_parted_machine_output_is_read_in_bytes(self):
        with mock.patch.object(installer, "run_cmd", return_value=PARTED_GPT) as run:
            layout = installer.read_partition_table("/dev/sda")
        self.assertEqual(run.call_args[0][0], ["parted", "-s", "-m", "/dev/sda", "unit", "B", "print"])
        self.assertEqual(layout["label"], "gpt")
        self.assertEqual([p["path"] for p in layout["partitions"]], ["/dev/sda1", "/dev/sda2"])
        self.assertTrue(layout["partitions"][0]["esp"])
        self.assertFalse(layout["partitions"][1]["esp"])
        self.assertEqual(layout["partitions"][1]["size"], 40 * GIB)
        self.assertEqual(layout["partitions"][0]["label"], "EFI system partition")

    def test_nvme_partitions_are_named_with_p(self):
        out = PARTED_GPT.replace("/dev/sda:", "/dev/nvme0n1:")
        with mock.patch.object(installer, "run_cmd", return_value=out):
            layout = installer.read_partition_table("/dev/nvme0n1")
        self.assertEqual(layout["partitions"][1]["path"], "/dev/nvme0n1p2")

    def test_a_disk_without_a_table_is_refused(self):
        with mock.patch.object(installer, "run_cmd", side_effect=RuntimeError("unrecognised disk label")):
            with self.assertRaisesRegex(RuntimeError, "Erase the drive"):
                installer.read_partition_table("/dev/sda")
        unknown = "BYT;\n/dev/sda:107374182400B:scsi:512:512:unknown:QEMU HARDDISK:;\n"
        with mock.patch.object(installer, "run_cmd", return_value=unknown):
            with self.assertRaisesRegex(RuntimeError, "Erase the drive"):
                installer.read_partition_table("/dev/sda")


class PlanningAnInstallBeside(unittest.TestCase):
    def plan(self, layout, replace=None, uefi=True, busy=frozenset()):
        with mock.patch.object(installer, "booted_with_uefi", return_value=uefi), \
                mock.patch.object(installer, "read_partition_table", return_value=layout), \
                mock.patch.object(installer, "busy_partitions", return_value=set(busy)), \
                mock.patch.object(installer, "partition_number", side_effect=lambda node: int(node[-1])), \
                mock.patch.object(installer, "run_cmd", return_value="") as run:
            result = installer.plan_beside_install("/dev/sda", replace)
        return result, run

    def test_free_space_is_planned_without_touching_the_disk(self):
        plan, run = self.plan(shared_disk())
        self.assertEqual(plan["region"], (101 + 40 * 1024, 100 * 1024 - 1))
        self.assertIsNone(plan["replace"])
        # Nothing is run, not even a read-only mount of the other system's ESP.
        run.assert_not_called()

    def test_a_partition_can_be_replaced(self):
        plan, _ = self.plan(shared_disk(size_gib=45), replace="/dev/sda2")
        self.assertEqual(plan["replace"], {"path": "/dev/sda2", "number": 2})
        self.assertEqual(plan["region"], (101, 45 * 1024 - 1))

    def test_refusals_come_before_anything_is_written(self):
        cases = (
            (dict(uefi=False), RuntimeError, "legacy BIOS"),
            (dict(layout={"label": "msdos", "usable": (MIB, 100 * GIB), "partitions": []}), RuntimeError, "GPT"),
            (dict(layout=shared_disk(partitions=[part("/dev/sda2", 101, 1024)])), RuntimeError, "no EFI system"),
            (dict(busy={"/dev/sda2"}), RuntimeError, "in use"),
            (dict(replace="/dev/sda1"), ValueError, "EFI system partition"),
            (dict(replace="/dev/sdb1"), ValueError, "not a partition of"),
            (dict(replace="/dev/sda"), ValueError, "not a partition device"),
            (dict(layout=shared_disk(size_gib=45)), RuntimeError, "not enough room"),
        )
        for overrides, error, message in cases:
            with self.subTest(message=message):
                kwargs = {"layout": shared_disk()}
                kwargs.update(overrides)
                with self.assertRaisesRegex(error, message):
                    self.plan(**kwargs)


class PartitioningBeside(unittest.TestCase):
    def run_partitioning(self, plan):
        numbers = iter([{1, 2}, {1, 2, 3}, {1, 2, 3}, {1, 2, 3, 4}, {1, 2, 3, 4}, {1, 2, 3, 4, 5},
                        {1, 2, 3, 4, 5}, {1, 2, 3, 4, 5, 6}])
        calls = []
        with mock.patch.object(installer, "partition_numbers", side_effect=lambda disk: next(numbers)), \
                mock.patch.object(installer, "run_cmd", side_effect=lambda cmd, check=True: calls.append(cmd) or ""), \
                mock.patch.object(installer.time, "sleep"), \
                mock.patch.object(installer.os.path, "exists", return_value=True):
            nodes = installer.partition_beside("/dev/sda", plan)
        return nodes, calls

    def test_its_own_esp_root_data_and_swap_fill_the_planned_stretch(self):
        plan = {"region": (41061, 102399), "replace": None}
        nodes, calls = self.run_partitioning(plan)
        self.assertEqual(nodes, (3, "/dev/sda3", "/dev/sda4", "/dev/sda5", "/dev/sda6"))
        self.assertIn(["parted", "-s", "/dev/sda", "set", "3", "esp", "on"], calls)
        mkparts = [c for c in calls if "mkpart" in c]
        self.assertEqual([c[5:] for c in mkparts], [
            ["LABKIOSK_ESP", "fat32", "41061MiB", "41189MiB"],
            ["LABKIOSK_ROOT", "ext4", "41189MiB", f"{102399 - 512 - 1024}MiB"],
            ["LABKIOSK_DATA", "ext4", f"{102399 - 512}MiB", "102399MiB"],
            ["LABKIOSK_SWAP", "linux-swap", f"{102399 - 512 - 1024}MiB", f"{102399 - 512}MiB"],
        ])
        self.assertFalse([c for c in calls if c[0] in ("wipefs", "mklabel") or "mklabel" in c or "rm" in c])

    def test_a_replaced_partition_is_wiped_and_removed_first(self):
        plan = {"region": (101, 46079), "replace": {"path": "/dev/sda2", "number": 2}}
        _, calls = self.run_partitioning(plan)
        self.assertEqual(calls[0], ["wipefs", "-a", "/dev/sda2"])
        self.assertEqual(calls[1], ["parted", "-s", "/dev/sda", "rm", "2"])

    def test_it_waits_for_the_new_device_nodes_and_stops_without_them(self):
        seen = iter([False, False, True, True])
        with mock.patch.object(installer, "run_cmd", return_value="") as run, \
                mock.patch.object(installer.time, "sleep"), \
                mock.patch.object(installer.os.path, "exists", side_effect=lambda node: next(seen)):
            installer.wait_for_partition_nodes("/dev/sda", ("/dev/sda3", "/dev/sda4"))
        self.assertEqual(run.call_count, 2)
        with mock.patch.object(installer, "run_cmd", return_value=""), \
                mock.patch.object(installer.time, "sleep"), \
                mock.patch.object(installer.os.path, "exists", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "/dev/sda3 did not appear"):
                installer.wait_for_partition_nodes("/dev/sda", ("/dev/sda3",), attempts=3)

    def test_one_new_partition_per_mkpart_or_it_stops(self):
        plan = {"region": (41061, 102399), "replace": None}
        with mock.patch.object(installer, "partition_numbers", return_value={1, 2}), \
                mock.patch.object(installer, "run_cmd", return_value=""):
            with self.assertRaisesRegex(RuntimeError, "0 new partitions"):
                installer.partition_beside("/dev/sda", plan)


EFIBOOTMGR = """BootCurrent: 0001
Timeout: 1 seconds
BootOrder: 0001,0003
Boot0001* Windows Boot Manager\tHD(1,GPT,...)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)
Boot0003* Lab Kiosk\tHD(1,GPT,...)/File(\\EFI\\LabKiosk\\shimx64.efi)
"""


class FirmwareBootEntry(unittest.TestCase):
    def test_the_listing_is_read_with_or_without_device_paths(self):
        order, entries = installer.boot_entries(EFIBOOTMGR + "Boot0004  Lab Kiosk Old\n")
        self.assertEqual(order, ["0001", "0003"])
        self.assertEqual(entries, {"0001": "Windows Boot Manager", "0003": "Lab Kiosk", "0004": "Lab Kiosk Old"})

    def test_an_old_entry_is_replaced_by_one_first_in_the_order(self):
        calls = []
        after = ("BootOrder: 0005,0001\nBoot0001* Windows Boot Manager\tHD()\n"
                 "Boot0005* Lab Kiosk\tHD(1,GPT)/File(\\EFI\\LabKiosk\\shimx64.efi)\n")

        def run(cmd, check=True):
            calls.append(cmd)
            return EFIBOOTMGR if len(calls) == 1 else after

        with mock.patch.object(installer, "run_cmd", side_effect=run):
            installer.register_boot_entry("/dev/nvme0n1", 1)
        self.assertEqual(calls[1], ["efibootmgr", "--bootnum", "0003", "--delete-bootnum"])
        self.assertEqual(calls[2], ["efibootmgr", "--create", "--disk", "/dev/nvme0n1", "--part", "1",
                                    "--label", "Lab Kiosk", "--loader", "\\EFI\\LabKiosk\\shimx64.efi"])

    def test_firmware_that_does_not_keep_it_first_fails_the_install(self):
        unchanged = "BootOrder: 0001\nBoot0001* Windows Boot Manager\tHD()\n"
        with mock.patch.object(installer, "run_cmd", return_value=unchanged):
            with self.assertRaisesRegex(RuntimeError, "did not keep its boot entry"):
                installer.register_boot_entry("/dev/sda", 1)


class InstallerBesideAnotherSystem(unittest.TestCase):
    def test_the_other_systems_boot_sector_and_esp_are_left_alone(self):
        source = read(INSTALLER_PATH)
        install = source.split("def install_to_disk")[1].split("\ndef ")[0]
        removable = install.index('"--removable"')
        self.assertLess(install.rindex("if not beside:", 0, removable), removable)
        bios = install.index('"--target=i386-pc"')
        self.assertIn("if not beside and not", install[install.rindex("if ", 0, bios):bios])
        # Beside another system the ESP formatted and booted from is Lab Kiosk's own.
        self.assertIn('run_cmd(["mkfs.vfat", "-F", "32", "-n", BESIDE_ESP_LABEL if beside else "ESP", part_esp])',
                      install)
        self.assertIn("esp_number, part_esp, part_root, part_data, part_swap = partition_beside(", install)
        self.assertIn("register_boot_entry(target_disk, esp_number)", install)
        self.assertLessEqual(len(installer.BESIDE_ESP_LABEL), 11)

    def test_patterns_and_markers_match_the_agent(self):
        self.assertEqual(installer.PARTITION_PATTERN.pattern, agent.REPLACE_PARTITION_PATTERN.pattern)
        self.assertEqual(installer.NETBOOT_ARG, agent.NETBOOT_KERNEL_ARG)

    def test_the_cli_validates_before_doing_anything(self):
        for argv, message in (
            (["--target", "/dev/sda", "--replace-partition", "/dev/sda"], "must name one partition"),
            (["--dual-boot"], "one of the arguments"),
            (["--list-disks", "--dual-boot"], "require --target"),
        ):
            with self.subTest(argv=argv):
                result = subprocess.run([sys.executable, INSTALLER_PATH] + argv, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True,
                                        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
                self.assertEqual(result.returncode, 2)
                self.assertIn(message, result.stderr)

    def test_a_network_booted_computer_is_never_installed(self):
        with mock.patch.object(installer, "kernel_args", return_value=["boot=live", "labkiosk.netboot=1"]), \
                mock.patch.object(installer.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(RuntimeError, "started over the network"):
                installer.install_to_disk("/dev/sda")
            self.assertEqual(installer.list_disks(), [])


class NetworkBootEnrolment(unittest.TestCase):
    def enrolment(self, cmdline, hostname="labkiosk-3fa92c"):
        with mock.patch.object(agent, "kernel_cmdline", return_value=cmdline), \
                mock.patch.object(agent.socket, "gethostname", return_value=hostname):
            return agent.network_boot_enrolment()

    def test_what_the_boot_menu_names_is_used_under_the_hostname(self):
        params = self.enrolment(f"boot=live labkiosk.netboot=1 labkiosk.org=Oakridge labkiosk.key={KEY.lower()}")
        self.assertEqual(params, {"subdomain": "oakridge", "customDomain": "", "key": KEY, "server": None,
                                  "clientId": "LABKIOSK-3FA92C"})
        params = self.enrolment(f"labkiosk.netboot=1 labkiosk.domain=kiosk.example.org labkiosk.key={KEY} "
                                "labkiosk.server=http://10.0.2.2")
        self.assertEqual((params["customDomain"], params["server"]), ("kiosk.example.org", "http://10.0.2.2"))

    def test_nothing_without_network_boot_or_an_organization(self):
        self.assertIsNone(self.enrolment(f"boot=live labkiosk.org=oakridge labkiosk.key={KEY}"))
        self.assertIsNone(self.enrolment("boot=live labkiosk.netboot=1"))

    def test_a_wrong_boot_menu_is_refused(self):
        for cmdline in (
            f"labkiosk.netboot=1 labkiosk.org=oakridge labkiosk.domain=kiosk.example.org labkiosk.key={KEY}",
            "labkiosk.netboot=1 labkiosk.org=oakridge labkiosk.key=AAAAA-AAAAA-AAAAA-AAAAB",
            f"labkiosk.netboot=1 labkiosk.org=-bad- labkiosk.key={KEY}",
            f"labkiosk.netboot=1 labkiosk.domain=localhost labkiosk.key={KEY}",
            f"labkiosk.netboot=1 labkiosk.org=oakridge labkiosk.key={KEY} labkiosk.server=http://example.org",
            "labkiosk.netboot=1 labkiosk.org=oakridge",
        ):
            with self.subTest(cmdline=cmdline):
                with self.assertRaises(ValueError):
                    self.enrolment(cmdline)

    def loop(self, outcomes, configured_after=None):
        calls, sleeps = [], []

        def enroll(*args):
            calls.append(args)
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            agent.state["isConfigured"] = True

        params = {"subdomain": "oakridge", "customDomain": "", "key": KEY, "server": None,
                  "clientId": "LABKIOSK-3FA92C"}
        orig = agent.state["isConfigured"]
        agent.state["isConfigured"] = False
        try:
            with mock.patch.object(agent, "network_boot_enrolment", return_value=params), \
                    mock.patch.object(agent, "enroll", side_effect=enroll):
                agent.network_boot_enrol_loop(sleep=sleeps.append)
        finally:
            agent.state["isConfigured"] = orig
        return calls, sleeps

    def test_an_unreachable_server_is_retried_soon_and_a_refusal_slowly(self):
        calls, sleeps = self.loop([agent.EnrolmentUnreachable("Could not reach it."),
                                   ValueError("Invalid enrollment key"), None])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0], ("oakridge", "LABKIOSK-3FA92C", KEY, None, ""))
        self.assertEqual(sleeps, [agent.NETBOOT_RETRY_SECONDS, agent.NETBOOT_REFUSED_RETRY_SECONDS])
        self.assertGreaterEqual(agent.NETBOOT_REFUSED_RETRY_SECONDS, 600)

    def test_a_wrong_menu_enrols_nothing(self):
        with mock.patch.object(agent, "network_boot_enrolment", side_effect=ValueError("bad")), \
                mock.patch.object(agent, "enroll") as enroll:
            agent.network_boot_enrol_loop(sleep=lambda seconds: self.fail("must not wait"))
        enroll.assert_not_called()

    def test_unreachable_is_a_value_error_the_wizard_already_shows(self):
        self.assertTrue(issubclass(agent.EnrolmentUnreachable, ValueError))

    def test_the_agent_starts_it_only_on_network_boot(self):
        main = read(CHROOT, "opt/labkiosk/agent/agent.py").split("def main():")[1]
        self.assertIn("if is_network_boot():\n        threading.Thread(target=network_boot_enrol_loop", main)


class NetworkBootAdministratorGate(unittest.TestCase):
    def gate(self, cmdline):
        with mock.patch.object(agent, "kernel_cmdline", return_value=cmdline):
            return agent.admin_auth_required(), agent.read_admin_password_hash

    def test_the_boot_menus_digest_gates_settings(self):
        with mock.patch.object(agent, "kernel_cmdline", return_value=f"labkiosk.netboot=1 labkiosk.admin={DIGEST}"):
            self.assertTrue(agent.admin_auth_required())
            self.assertEqual(agent.read_admin_password_hash(), DIGEST)

    def test_no_digest_is_setup_mode_like_live_media(self):
        with mock.patch.object(agent, "kernel_cmdline", return_value="boot=live labkiosk.netboot=1"):
            self.assertFalse(agent.admin_auth_required())
            self.assertIsNone(agent.read_admin_password_hash())

    def test_a_damaged_digest_keeps_the_gate_shut(self):
        with mock.patch.object(agent, "kernel_cmdline", return_value="labkiosk.netboot=1 labkiosk.admin=nonsense"):
            self.assertTrue(agent.admin_auth_required())
            with self.assertRaises(ValueError):
                agent.read_admin_password_hash()


class InstallApi(unittest.TestCase):
    def post(self, body, netboot=False):
        handler = object.__new__(agent.LocalApiHandler)
        handler.path = "/api/install"
        handler.headers = {"Host": "127.0.0.1:8888"}
        handler.sent = None
        handler._send = lambda status, payload, content_type="application/json": setattr(handler, "sent", (status, payload))
        handler._read_json = lambda: body
        with mock.patch.object(agent, "is_live_session", return_value=True), \
                mock.patch.object(agent, "is_network_boot", return_value=netboot), \
                mock.patch.object(agent, "start_disk_install") as start:
            handler.do_POST()
        return handler.sent, start

    def test_installing_beside_needs_the_risk_accepted(self):
        (status, payload), start = self.post({"targetDisk": "/dev/sda", "mode": "beside"})
        self.assertEqual(status, 400)
        self.assertIn("accept", payload["error"])
        start.assert_not_called()

    def test_beside_into_free_space_or_one_partition(self):
        (status, _), start = self.post({"targetDisk": "/dev/sda", "mode": "beside", "acceptRisk": True})
        self.assertEqual(status, 200)
        start.assert_called_once_with("/dev/sda", None, None, True, None)
        (status, _), start = self.post({"targetDisk": "/dev/nvme0n1", "mode": "beside", "acceptRisk": True,
                                        "replacePartition": "/dev/nvme0n1p3"})
        self.assertEqual(status, 200)
        start.assert_called_once_with("/dev/nvme0n1", None, None, True, "/dev/nvme0n1p3")

    def test_erase_stays_the_default(self):
        (status, payload), start = self.post({"targetDisk": "/dev/sda"})
        self.assertEqual((status, payload["mode"]), (200, "erase"))
        start.assert_called_once_with("/dev/sda", None, None, False, None)

    def test_wrong_requests_are_refused(self):
        for body in (
            {"targetDisk": "/dev/sda", "mode": "wipe"},
            {"targetDisk": "/dev/sda", "mode": "beside", "acceptRisk": "yes"},
            {"targetDisk": "/dev/sda", "mode": "beside", "acceptRisk": True, "replacePartition": "/dev/sdb2"},
            {"targetDisk": "/dev/sda", "mode": "beside", "acceptRisk": True, "replacePartition": "/dev/sda"},
            {"targetDisk": "/dev/sda", "mode": "beside", "acceptRisk": True, "replacePartition": "/dev/sda1;rm"},
            {"targetDisk": "/dev/sda", "replacePartition": "/dev/sda2"},
        ):
            with self.subTest(body=body):
                (status, _), start = self.post(body)
                self.assertEqual(status, 400)
                start.assert_not_called()

    def test_a_network_booted_workstation_has_no_installer(self):
        (status, payload), start = self.post({"targetDisk": "/dev/sda"}, netboot=True)
        self.assertEqual(status, 400)
        self.assertIn("network", payload["error"])
        start.assert_not_called()
        with mock.patch.object(agent, "is_network_boot", return_value=True):
            self.assertEqual(agent.get_available_disks(), [])

    def test_the_installer_is_called_with_the_mode(self):
        for kwargs, expected in (
            ({"beside": True}, ["--dual-boot"]),
            ({"beside": True, "replace_partition": "/dev/sda3"}, ["--replace-partition", "/dev/sda3"]),
            ({}, []),
        ):
            with self.subTest(kwargs=kwargs):
                argv = []
                with mock.patch.object(agent.subprocess, "run", side_effect=lambda cmd, check: argv.extend(cmd)), \
                        mock.patch.object(agent.threading, "Thread",
                                          side_effect=lambda target, daemon: mock.Mock(start=target)):
                    agent.start_disk_install("/dev/sda", **kwargs)
                self.assertEqual(argv[:4], ["sudo", "/usr/local/bin/labkiosk-install", "--target", "/dev/sda"])
                self.assertEqual(argv[4:], expected)


class Wizard(unittest.TestCase):
    def setUp(self):
        self.wizard = read(CHROOT, "opt/labkiosk/setup/wizard.html")

    def test_it_sends_the_mode_and_the_accepted_risk(self):
        self.assertIn("mode: beside ? 'beside' : 'erase', replacePartition, acceptRisk: beside && acceptDualBootRisk.checked",
                      self.wizard)
        self.assertIn('id="accept-dual-boot-risk"', self.wizard)
        self.assertIn('data-i18n="ui.dual-boot-risk"', self.wizard)

    def test_the_gate_follows_the_agent_not_only_live_media(self):
        self.assertNotIn("!isLive && !adminToken", self.wizard)
        self.assertIn("adminGate = typeof data.adminRequired === 'boolean'", self.wizard)
        status = read(CHROOT, "opt/labkiosk/agent/agent.py").split('if self.path == "/api/status"')[1][:6000]
        for field in ('"isNetworkBoot": network_boot', '"adminRequired": admin_auth_required()'):
            self.assertIn(field, status)


class BootServerTool(unittest.TestCase):
    def args(self, **overrides):
        values = {"server_address": "192.168.1.10", "org": "oakridge", "domain": "", "key": KEY,
                  "control_plane": None, "admin_hash": DIGEST, "timezone": "Asia/Kolkata"}
        values.update(overrides)
        return mock.Mock(**values)

    def test_it_checks_enrollment_keys_exactly_as_the_agent_does(self):
        alphabet = tool.ENROLLMENT_KEY_ALPHABET
        self.assertEqual(alphabet, agent.ENROLLMENT_KEY_ALPHABET)
        for payload in ("AAAAAAAAAAAAAAAAAAA", "ABCDEFGHJKMNPQRSTVW", "YZ23456789ABCDEFGHJ", "9999999999999999999"):
            with self.subTest(payload=payload):
                self.assertEqual(tool.enrollment_key_check_character(payload),
                                 agent.enrollment_key_check_character(payload))
        self.assertTrue(tool.enrollment_key_is_valid(KEY))
        self.assertFalse(tool.enrollment_key_is_valid("AAAAA-AAAAA-AAAAA-AAAAB"))

    def test_its_patterns_are_the_agents(self):
        for name in ("ORG_SUBDOMAIN_PATTERN", "CUSTOM_DOMAIN_PATTERN", "GRUB_PBKDF2_PATTERN"):
            with self.subTest(name=name):
                self.assertEqual(getattr(tool, name).pattern, getattr(agent, name).pattern)

    def test_the_command_line_boots_the_image_from_ram_and_enrols(self):
        words = tool.kernel_arguments(self.args(), "2.9.0").split()
        for required in ("boot=live", "components", "fetch=http://192.168.1.10/labkiosk/2.9.0/filesystem.squashfs",
                         "overlayroot=tmpfs:recurse=0", "username=kiosk", "noeject", "panic=10",
                         agent.NETBOOT_KERNEL_ARG, "labkiosk.org=oakridge", f"labkiosk.key={KEY}",
                         f"labkiosk.admin={DIGEST}"):
            self.assertIn(required, words)
        self.assertFalse([w for w in words if w.startswith("labkiosk.installed")])

    def test_the_agent_reads_back_what_the_tool_writes(self):
        cmdline = tool.kernel_arguments(self.args(control_plane="http://10.0.2.2"), "2.9.0")
        with mock.patch.object(agent, "kernel_cmdline", return_value=cmdline), \
                mock.patch.object(agent.socket, "gethostname", return_value="labkiosk-3fa92c"):
            params = agent.network_boot_enrolment()
            self.assertEqual(agent.read_admin_password_hash(), DIGEST)
        self.assertEqual((params["subdomain"], params["key"], params["server"]), ("oakridge", KEY, "http://10.0.2.2"))

    def test_the_grub_menu_boots_unattended_and_is_locked_with_the_password(self):
        menu = tool.grub_menu(self.args(), "2.9.0")
        self.assertIn('set superusers="labkiosk"', menu)
        self.assertIn(f"password_pbkdf2 labkiosk {DIGEST}", menu)
        self.assertIn("--unrestricted", menu)
        # From GRUB's own boot device: Debian's signed network GRUB may have no HTTP client.
        self.assertIn("    linux /labkiosk/2.9.0/vmlinuz ", menu)
        self.assertIn("    initrd /labkiosk/2.9.0/initrd.img", menu)
        self.assertNotIn("http", menu.split("menuentry")[1].split("vmlinuz")[0])
        self.assertNotIn("insmod http", menu)
        self.assertNotIn("superusers", tool.grub_menu(self.args(admin_hash=None), "2.9.0"))

    def test_the_ipxe_script(self):
        script = tool.ipxe_script(self.args(), "2.9.0").splitlines()
        self.assertEqual(script[0], "#!ipxe")
        self.assertTrue(script[2].startswith("kernel http://192.168.1.10/labkiosk/2.9.0/vmlinuz initrd=initrd.img "))
        self.assertEqual(script[3:5], ["initrd http://192.168.1.10/labkiosk/2.9.0/initrd.img", "boot"])

    def test_prepare_lays_out_the_web_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = os.path.join(tmp, "live")
            os.makedirs(live)
            for name in tool.IMAGE_FILES:
                with open(os.path.join(live, name), "wb") as handle:
                    handle.write(name.encode())
            extracted = {}
            for path, content in ((tool.VERSION_FILE, "2.9.0\n"), (tool.SHIM, "shim"), (tool.NETWORK_GRUB, "grub")):
                extracted[path] = os.path.join(tmp, os.path.basename(path))
                with open(extracted[path], "w", encoding="utf-8") as handle:
                    handle.write(content)
            out = os.path.join(tmp, "www")
            argv = ["prepare", "--live-dir", live, "--out", out, "--server-address", "192.168.1.10",
                    "--org", "oakridge", "--key", KEY, "--admin-hash", DIGEST]
            with mock.patch.object(tool, "extract_from_squashfs", side_effect=lambda sq, path, scratch: extracted[path]), \
                    mock.patch.object(tool, "UNDIONLY_CANDIDATES", ()), \
                    mock.patch("sys.stdout"), mock.patch("sys.stderr"):
                self.assertEqual(tool.main(argv), 0)
            for name in tool.IMAGE_FILES:
                self.assertEqual(read(out, "labkiosk", "2.9.0", name), name)
            self.assertEqual(read(out, "labkiosk", "shimx64.efi"), "shim")
            self.assertEqual(read(out, "labkiosk", "grubx64.efi"), "grub")
            menus = {read(out, relative) for relative in tool.MENU_PATHS}
            self.assertEqual(len(menus), 1)
            self.assertIn("labkiosk/2.9.0/vmlinuz", menus.pop())
            self.assertTrue(read(out, "labkiosk", "boot.ipxe").startswith("#!ipxe\n"))
            self.assertFalse([n for n in os.listdir(os.path.join(out, "labkiosk")) if ".tmp-" in n])

    def test_wrong_arguments_stop_it(self):
        base = ["prepare", "--live-dir", "/nonexistent", "--out", "/nonexistent", "--server-address", "192.168.1.10"]
        for extra in (["--org", "oakridge", "--key", "AAAAA-AAAAA-AAAAA-AAAAB"],
                      ["--org", "oakridge", "--domain", "kiosk.example.org", "--key", KEY],
                      ["--org", "oakridge"],
                      ["--org", "oakridge", "--key", KEY, "--admin-hash", "secret"],
                      ["--org", "oakridge", "--key", KEY, "--control-plane", "https://x.example/path"]):
            with self.subTest(extra=extra), mock.patch("sys.stderr"), mock.patch("sys.stdout"):
                with self.assertRaises(SystemExit) as raised:
                    tool.main(base + extra)
                self.assertNotEqual(raised.exception.code, 0)
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            tool.main(["prepare", "--live-dir", "/x", "--out", "/x", "--server-address", "fe80::1"])

    def test_symbolic_links_inside_the_image_are_followed(self):
        with tempfile.TemporaryDirectory() as scratch:
            def run(cmd):
                target, path = cmd[3], cmd[5]
                full = os.path.join(target, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                if path == tool.SHIM:
                    os.symlink("/etc/alternatives/shimx64.efi.signed", full)
                elif path == "etc/alternatives/shimx64.efi.signed":
                    os.symlink("/usr/lib/shim/shimx64.efi.signed.latest", full)
                elif path == "usr/lib/shim/shimx64.efi.signed.latest":
                    with open(full, "w", encoding="utf-8") as handle:
                        handle.write("signed shim")
                return ""

            with mock.patch.object(tool, "run", side_effect=run):
                found = tool.extract_from_squashfs("/image.squashfs", tool.SHIM, scratch)
                self.assertEqual(read(found), "signed shim")


class Documented(unittest.TestCase):
    def test_a_distribution_package_is_recorded_as_rejected(self):
        faq = read(os.path.dirname(ROOT), "wiki", "FAQ.md")
        self.assertIn("distribution package", faq)
        self.assertIn("Network-Boot", read(os.path.dirname(ROOT), "wiki", "_Sidebar.md"))


if __name__ == "__main__":
    unittest.main()
