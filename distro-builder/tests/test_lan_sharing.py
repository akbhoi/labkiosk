#!/usr/bin/env python3
"""
Over-the-air updates, phase 5: sharing a release on the local network
(docs/OTA_UPDATES.md section 5.9).

    the agent        reports its LAN address and stops serving when the
                     organization stops sharing
    labkiosk-share   serves only a verified release's own files, only to its
                     subnet, never through a link
    labkiosk-update  copies the release from a peer first, refuses a peer's
                     wrong or broken release, and falls back to the internet

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import contextlib
import http.client
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.dont_write_bytecode = True

import test_update as base  # noqa: E402  (the phase 2 and 3 fixtures: keys, releases, the control plane)

ROOT = base.ROOT
CHROOT = base.CHROOT
REPO = os.path.dirname(ROOT)
update = base.update
slots = base.slots

agent = base.load("labkiosk_agent_lan", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))
agent.log = lambda message: None
share = base.load("labkiosk_share", os.path.join(CHROOT, "usr/local/sbin/labkiosk-share"))
share.log = lambda message: None
share.update.log = lambda message: None
share.slots.log = lambda message: None

LOOPBACK = ipaddress.ip_network("127.0.0.0/8")


def route(dev="eth0", prefsrc="192.168.10.23"):
    return [{"dst": "192.0.2.1", "gateway": "192.168.10.1", "dev": dev, "prefsrc": prefsrc, "flags": [], "uid": 0}]


def addresses(local="192.168.10.23", prefixlen=24):
    return [{"ifindex": 2, "ifname": "eth0", "addr_info": [
        {"family": "inet", "local": "10.9.9.9", "prefixlen": 8},
        {"family": "inet", "local": local, "prefixlen": prefixlen, "broadcast": "192.168.10.255"},
    ]}]


class AgentReportsItsLan(unittest.TestCase):
    def setUp(self):
        self.answers = {}
        self.asked = []
        saved = {name: getattr(agent, name) for name in ("_ip_json", "is_live_session", "subprocess")}
        self.addCleanup(lambda: [setattr(agent, n, v) for n, v in saved.items()])
        agent._lan_report.update(value=None, at=None, problem=None)
        agent._lan_sharing.update(allowed=None)

        def ip_json(args):
            self.asked.append(args)
            answer = self.answers[args[1]]
            if isinstance(answer, Exception):
                raise answer
            return answer

        agent._ip_json = ip_json

    def test_the_address_and_prefix_of_the_route_out(self):
        self.answers = {"route": route(), "addr": addresses()}
        self.assertEqual(agent.read_lan_address(), {"address": "192.168.10.23", "prefix": 24})
        self.assertEqual(self.asked[1], ["-4", "addr", "show", "dev", "eth0"])

    def test_only_a_private_ipv4_host_address_on_a_16_to_30_subnet(self):
        cases = [
            (route(prefsrc="203.0.113.7"), addresses(local="203.0.113.7")),  # public
            (route(prefsrc="169.254.3.4"), addresses(local="169.254.3.4")),  # link-local
            (route(), addresses(prefixlen=8)),                              # too wide a subnet
            (route(), addresses(prefixlen=31)),                             # no room for peers
            (route(prefsrc="192.168.10.0"), addresses(local="192.168.10.0")),  # the network itself
            (route(dev="eth0;reboot"), addresses()),                        # not an interface name
            ([], addresses()),                                              # no route at all
            (route(), [{"ifname": "eth0", "addr_info": "nonsense"}]),
        ]
        for routes, addrs in cases:
            with self.subTest(routes=routes, addrs=addrs):
                self.answers = {"route": routes, "addr": addrs}
                self.assertIsNone(agent.read_lan_address())

    def test_reported_once_a_minute_and_only_from_an_installed_disk(self):
        self.answers = {"route": route(), "addr": addresses()}
        self.assertEqual(agent.lan_report(now=100.0), {"address": "192.168.10.23", "prefix": 24})
        self.answers = {"route": OSError("ip is gone"), "addr": addresses()}
        self.assertEqual(agent.lan_report(now=130.0), {"address": "192.168.10.23", "prefix": 24}, "cached")
        self.assertIsNone(agent.lan_report(now=161.0), "re-read after a minute; a failure reports nothing")

        with mock.patch.object(agent, "lan_report", lambda: {"address": "10.1.2.3", "prefix": 24}), \
                mock.patch.object(agent, "read_update_report", lambda: {"phase": "idle"}), \
                mock.patch.object(agent, "image_version", lambda: "2.11.0"):
            agent.is_live_session = lambda: False
            self.assertEqual(agent.current_status()["lan"], {"address": "10.1.2.3", "prefix": 24})
            agent.is_live_session = lambda: True
            self.assertNotIn("lan", agent.current_status(), "a live session shares nothing")

    def test_the_server_is_stopped_once_when_sharing_is_turned_off(self):
        ran = []

        class FakeSubprocess:
            SubprocessError = subprocess.SubprocessError

            @staticmethod
            def run(argv, **kwargs):
                ran.append(argv)
                return subprocess.CompletedProcess(argv, 0, "", "")

        agent.subprocess = FakeSubprocess
        agent.is_live_session = lambda: False
        agent.apply_lan_sharing(True)
        self.assertEqual(ran, [], "starting is the root updater's")
        agent.apply_lan_sharing(False)
        agent.apply_lan_sharing(False)
        agent.apply_lan_sharing("no")
        self.assertEqual(ran, [["systemctl", "stop", "--no-block", "labkiosk-share.service"]])
        agent.apply_lan_sharing(True)
        agent.apply_lan_sharing(False)
        self.assertEqual(len(ran), 2)

    def test_the_hub_config_reaches_it(self):
        seen = []
        with mock.patch.object(agent, "apply_lan_sharing", seen.append), \
                mock.patch.object(agent, "sync_chromium_policies", lambda *a, **k: None):
            agent.apply_control_update({"lanSharing": False, "commands": []})
        self.assertEqual(seen, [False])


class ShareFixture(unittest.TestCase):
    """A second workstation at the same site, holding a release verified, and its share server."""

    # The keys, image store, release server and control plane of test_update,
    # borrowed rather than inherited so its tests do not run again here.
    setUpClass = base.Update.__dict__["setUpClass"]
    tearDownClass = base.Update.__dict__["tearDownClass"]
    publish = base.Update.publish
    write_manifest = base.Update.write_manifest
    serve = base.Update.serve
    control_plane = base.Run.control_plane
    run_update = base.Run.run_update
    state = base.Run.state

    def setUp(self):
        base.Run.setUp(self)
        self.peer_root = os.path.join(self.tmp, "peer")
        shutil.copytree(self.root, self.peer_root)

    def hold(self, version, **publish):
        """Publish `version` and download it into the peer's image store, as the peer's own updater would."""
        if not os.path.isdir(os.path.join(self.releases, version)):
            self.publish(version, **publish)
        server, releases = self.serve()
        update.download(self.peer_root, f"{releases}/{version}", base.RUNNING, base.FLOOR, self.keys, gpgv=base.GPGV)
        server.shutdown()
        return os.path.join(self.peer_root, "images", version)

    def share_server(self, network=LOOPBACK, address="127.0.0.1"):
        server = share.ShareServer((address, 0), network, self.peer_root)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def get(self, server, path, headers=None, method="GET"):
        connection = http.client.HTTPConnection(server.server_address[0], server.server_address[1], timeout=10)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()


class ShareServer(ShareFixture):
    def test_only_a_verified_release_s_own_files(self):
        folder = self.hold("2.6.1")
        server = self.share_server()
        status, headers, body = self.get(server, "/2.6.1/manifest.json")
        self.assertEqual(status, 200)
        with open(os.path.join(folder, "manifest.json"), "rb") as handle:
            self.assertEqual(body, handle.read())
        for name in slots.IMAGE_FILES + ("manifest.json.sig",):
            self.assertEqual(self.get(server, f"/2.6.1/{name}", method="HEAD")[0], 200, name)
        for path in ("/2.6.1/.verified", "/2.6.1/", "/2.6.1", "/", "/2.6.0/vmlinuz", "/2.5.1/vmlinuz",
                     "/../boot/grub/grubenv", "/2.6.1/../../boot/grub/grubenv", "/2.6.1/vmlinuz?x=1",
                     "/2.6.1%2Fvmlinuz", "/9.9.9/vmlinuz"):
            with self.subTest(path=path):
                self.assertEqual(self.get(server, path)[0], 404)

    def test_no_path_leaves_the_image_store(self):
        store = os.path.join(self.root, "images")
        self.assertEqual(share.image_path(self.root, "2.6.1", "vmlinuz"), os.path.join(store, "2.6.1", "vmlinuz"))
        for version, name in ((".", "vmlinuz"), ("..", "boot"), ("2.6.1", ".."), ("2.6.1", "."), ("..", ".."),
                              ("2.6.1/..", "vmlinuz"), ("/etc", "passwd"), ("2.6.1", "../../boot/grub/grubenv")):
            with self.subTest(version=version, name=name):
                self.assertIsNone(share.image_path(self.root, version, name))

    def test_ranges_resume_where_the_updater_asks(self):
        folder = self.hold("2.6.1")
        server = self.share_server()
        with open(os.path.join(folder, "filesystem.squashfs"), "rb") as handle:
            data = handle.read()
        status, headers, body = self.get(server, "/2.6.1/filesystem.squashfs", {"Range": f"bytes={base.CHUNK}-"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], f"bytes {base.CHUNK}-{len(data) - 1}/{len(data)}")
        self.assertEqual(body, data[base.CHUNK:])
        self.assertEqual(self.get(server, "/2.6.1/filesystem.squashfs", {"Range": "bytes=0-9"})[2], data[:10])
        for bad in (f"bytes={len(data)}-", "bytes=5-2", "bytes=-100", "bytes=0-1,4-5", "lines=1-"):
            with self.subTest(bad=bad):
                self.assertEqual(self.get(server, "/2.6.1/filesystem.squashfs", {"Range": bad})[0], 416)

    def test_an_unverified_tampered_or_linked_copy_is_not_served(self):
        folder = self.hold("2.6.1")
        server = self.share_server()
        marker = os.path.join(folder, ".verified")
        with open(marker, encoding="utf-8") as handle:
            good = handle.read()
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write("0" * 64 + "\n")
        self.assertEqual(self.get(server, "/2.6.1/vmlinuz")[0], 404, "verified with another manifest")
        os.unlink(marker)
        self.assertEqual(self.get(server, "/2.6.1/vmlinuz")[0], 404, "never verified")
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write(good)
        with open(os.path.join(folder, "initrd.img"), "ab") as handle:
            handle.write(b"x")
        self.assertEqual(self.get(server, "/2.6.1/initrd.img")[0], 404, "a copy no longer the manifest's size")
        os.unlink(os.path.join(folder, "vmlinuz"))
        os.symlink(os.path.join(self.peer_root, "boot", "grub", "grubenv"), os.path.join(folder, "vmlinuz"))
        self.assertEqual(self.get(server, "/2.6.1/vmlinuz")[0], 404, "never through a link")

    def test_only_its_own_private_subnet_is_answered(self):
        server = share.ShareServer(("127.0.0.1", 0), ipaddress.ip_network("192.168.10.0/24"), self.peer_root)
        self.addCleanup(server.server_close)
        self.assertTrue(server.verify_request(None, ("192.168.10.77", 5000)))
        for address in ("192.168.11.77", "8.8.8.8", "127.0.0.1", "::1", "fe80::1", "not an address"):
            with self.subTest(address=address):
                self.assertFalse(server.verify_request(None, (address, 5000)))

    def test_a_busy_server_sends_the_next_one_elsewhere(self):
        self.hold("2.6.1")
        server = self.share_server()
        for _ in range(share.MAX_UPLOADS):
            server.uploads.acquire()
        self.addCleanup(lambda: [server.uploads.release() for _ in range(share.MAX_UPLOADS)])
        status, headers, _ = self.get(server, "/2.6.1/vmlinuz")
        self.assertEqual((status, headers.get("Retry-After")), (503, "60"))

    def test_it_never_runs_as_root(self):
        with mock.patch.object(share.os, "geteuid", lambda: 0):
            self.assertEqual(share.main(), 1)


class CopiedFromPeers(ShareFixture):
    """`run` with LAN sharing: a peer first, the internet when no peer delivers."""

    def setUp(self):
        super().setUp()
        # A peer on loopback stands in for one on the LAN, at the share server's port.
        networks = update.LAN_PRIVATE_NETWORKS
        port = update.LAN_SHARE_PORT
        self.addCleanup(setattr, update, "LAN_PRIVATE_NETWORKS", networks)
        self.addCleanup(setattr, update, "LAN_SHARE_PORT", port)
        update.LAN_PRIVATE_NETWORKS = networks + (LOOPBACK,)

    def offer(self, releases, peers, version="2.6.1"):
        return {
            "release": {"version": version, "kind": "feature", "sizeBytes": 1, "url": f"{releases}/{version}"},
            "security": None,
            "securityUpdates": "approval",
            "lan": {"peers": peers},
        }

    def at_port(self, port):
        update.LAN_SHARE_PORT = port

    def test_a_release_is_copied_from_a_peer_without_the_proxy_and_then_shared(self):
        self.hold("2.6.1")
        peer = self.share_server(address="127.0.0.2")
        self.at_port(peer.server_address[1])
        cloud, releases = self.serve()
        cloud.requests.clear()
        _, worker = self.control_plane(None, body=self.offer(releases, ["127.0.0.2"]))
        # The organization's proxy (dead here) is for the internet; a peer is reached directly.
        with mock.patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:9", "no_proxy": "127.0.0.1"}):
            result = self.run_update(worker)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(cloud.requests, [], "nothing came from the internet")
        self.assertTrue(os.path.isfile(os.path.join(self.root, "images", "2.6.1", ".verified")))
        self.assertEqual(self.sharing, [True], "held, it serves the release to its site")

    def test_a_peer_serving_a_broken_chunk_is_dropped_and_the_internet_finishes(self):
        folder = self.hold("2.6.1")
        path = os.path.join(folder, "filesystem.squashfs")
        with open(path, "r+b") as handle:
            handle.seek(base.CHUNK + 10)
            handle.write(b"\x00" if handle.read(1) != b"\x00" else b"\x01")
        peer = self.share_server()
        self.at_port(peer.server_address[1])
        cloud, releases = self.serve()
        cloud.requests.clear()
        _, worker = self.control_plane(None, body=self.offer(releases, ["127.0.0.1"]))
        self.assertEqual(self.run_update(worker)["state"], "ready")
        fetched = [name for name, _ in cloud.requests]
        self.assertNotIn("vmlinuz", fetched, "what the peer delivered intact is kept")
        self.assertIn(("filesystem.squashfs", f"bytes={base.CHUNK}-"), cloud.requests,
                      "the internet resumes after the last good chunk")
        self.assertTrue(os.path.isfile(os.path.join(self.root, "images", "2.6.1", ".verified")))

    def test_an_unreachable_peer_costs_only_a_moment(self):
        self.publish("2.6.1")
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        self.at_port(closed.getsockname()[1])
        closed.close()
        _, releases = self.serve()
        _, worker = self.control_plane(None, body=self.offer(releases, ["127.0.0.1", "127.0.0.1"]))
        self.assertEqual(self.run_update(worker)["state"], "ready")

    def test_a_peer_offering_another_signed_release_is_refused_before_anything_is_written(self):
        self.publish("2.6.1")
        self.publish("2.6.2")
        # A hostile peer answers for 2.6.1 with 2.6.2, validly signed: plain files, no share server checks.
        hostile = os.path.join(self.tmp, "hostile")
        shutil.copytree(os.path.join(self.releases, "2.6.2"), os.path.join(hostile, "2.6.1"))
        server = base.release_server.start_in_thread(hostile)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.at_port(server.server_address[1])
        _, releases = self.serve()
        _, worker = self.control_plane(None, body=self.offer(releases, ["127.0.0.1"]))
        self.assertEqual(self.run_update(worker)["state"], "ready")
        self.assertFalse(os.path.exists(os.path.join(self.root, "downloads", "2.6.2")))
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "images"))), ["2.6.0", "2.6.1"],
                         "the rollback image makes room, as for any download")

    def test_without_sharing_nothing_is_tried_on_the_lan_and_the_server_stops(self):
        self.publish("2.6.1")
        _, releases = self.serve()
        body = self.offer(releases, [])
        body["lan"] = None
        _, worker = self.control_plane(None, body=body)
        self.assertEqual(self.run_update(worker)["state"], "ready")
        self.assertEqual(self.sharing, [False])

    def test_a_release_held_for_two_days_is_no_longer_served(self):
        self.publish("2.6.1")
        _, releases = self.serve()
        _, worker = self.control_plane(None, body=self.offer(releases, []))
        self.assertEqual(self.run_update(worker)["state"], "ready")
        self.assertEqual(self.sharing, [True])
        # A later run within the window serves it again; past it, the port stays closed.
        self.assertEqual(self.run_update(worker)["state"], "ready")
        self.assertEqual(self.sharing, [True, True])
        held = self.state()
        held["since"] -= update.LAN_SHARE_SECONDS
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(held, handle)
        self.assertEqual(self.run_update(worker)["state"], "ready")
        self.assertEqual(self.sharing, [True, True, False])
        self.assertEqual(self.state()["since"], held["since"], "the hold keeps its first time")

    def test_the_peer_list_is_checked(self):
        self.assertIsNone(update.parse_lan(None))
        self.assertEqual(update.parse_lan({"peers": ["192.168.10.4"]}), {"peers": ["192.168.10.4"]})
        for bad in ({"peers": ["8.8.8.8"]}, {"peers": ["169.254.1.1"]}, {"peers": ["192.168.10.4:22"]},
                    {"peers": ["fd00::1"]}, {"peers": [7]}, {"peers": "192.168.10.4"}, {},
                    {"peers": ["10.0.0.1"] * (update.MAX_PEERS_OFFERED + 1)}, "on"):
            with self.subTest(bad=bad):
                with self.assertRaises(update.UpdateError):
                    update.parse_lan(bad)


class Packaging(unittest.TestCase):
    def read(self, rel):
        with open(os.path.join(ROOT, rel), encoding="utf-8") as handle:
            return handle.read()

    def test_the_unit_runs_unprivileged_for_two_days_behind_the_kernel_rule(self):
        unit = self.read("config/includes.chroot/etc/systemd/system/labkiosk-share.service")
        for line in ("ExecStart=/usr/local/sbin/labkiosk-share\n", "DynamicUser=yes\n", "RuntimeMaxSec=48h\n",
                     "InaccessiblePaths=-/etc/labkiosk\n", "ProtectSystem=strict\n", "NoNewPrivileges=yes\n",
                     "CapabilityBoundingSet=\n", "ConditionKernelCommandLine=labkiosk.installed=1\n",
                     "ExecStartPre=+/usr/sbin/nft -f /usr/share/labkiosk/labkiosk-share.nft\n",
                     "ExecStopPost=-+/usr/sbin/nft delete table inet labkiosk_share\n", "IOSchedulingClass=idle\n"):
            self.assertIn(line, unit)
        self.assertNotIn("[Install]", unit, "started when a release spreads, never at boot")

    def test_two_days_everywhere(self):
        self.assertEqual(update.LAN_SHARE_SECONDS, 48 * 60 * 60)
        with open(os.path.join(REPO, "cloudflare-control", "src", "lan_sharing.ts"), encoding="utf-8") as handle:
            self.assertIn("export const LAN_SHARE_SECONDS = 48 * 60 * 60;", handle.read(),
                          "the hub stops naming a peer when it stops serving")

    def test_one_port_everywhere(self):
        port = str(update.LAN_SHARE_PORT)
        rule = self.read("config/includes.chroot/usr/share/labkiosk/labkiosk-share.nft")
        self.assertEqual(rule.count(f"tcp dport {port} "), 2)
        self.assertIn("10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16", rule)
        self.assertEqual(share.LAN_SHARE_PORT, update.LAN_SHARE_PORT)
        with open(os.path.join(REPO, "cloudflare-control", "src", "ui_admin_updates.ts"), encoding="utf-8") as handle:
            self.assertIn(f"TCP port {port}", handle.read(), "the console tells administrators which port")

    def test_the_image_carries_nftables_and_an_executable_server(self):
        packages = self.read("config/package-lists/kiosk.list.chroot").split()
        self.assertIn("nftables", packages)
        hook = self.read("config/hooks/live/01-lockdown.hook.chroot")
        self.assertIn("chmod +x /usr/local/sbin/labkiosk-share", hook)
        self.assertNotIn("systemctl enable labkiosk-share", hook)
        self.assertNotIn("systemctl enable nftables", hook)

    @unittest.skipUnless(shutil.which("nft"), "needs nft to check the rule")
    def test_the_rule_parses(self):
        # `nft -c` still opens netlink, which needs CAP_NET_ADMIN: as root, else in a
        # network namespace of its own, else through passwordless sudo (CI runners).
        check = ["nft", "-c", "-f", os.path.join(CHROOT, "usr/share/labkiosk/labkiosk-share.nft")]
        ways = [check] if os.geteuid() == 0 else [["unshare", "-rn", *check], ["sudo", "-n", *check]]
        refused = []
        for command in ways:
            if not shutil.which(command[0]):
                continue
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            if result.returncode == 0:
                return
            if "Operation not permitted" not in result.stderr and "password is required" not in result.stderr:
                self.fail(f"{' '.join(command[:-1])} rejects the rule: {result.stderr}")
            refused.append(f"{command[0]}: {result.stderr.strip()}")
        self.skipTest("no way to give nft CAP_NET_ADMIN here: " + "; ".join(refused))


if __name__ == "__main__":
    unittest.main()
