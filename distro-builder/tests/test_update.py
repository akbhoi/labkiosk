#!/usr/bin/env python3
"""
labkiosk-update against a release served on loopback and an image store in a
temporary directory (over-the-air updates, phase 2).

The signing key is made fresh for every run with gpg; the workstation's side
verifies with gpgv, as it does on a real disk. Needs gpg and gpgv, which every
Debian and Ubuntu system has.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import hashlib
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
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


update = load("labkiosk_update", os.path.join(CHROOT, "usr/local/sbin/labkiosk-update"))
manifests = load("make_release_manifest", os.path.join(ROOT, "tools/make-release-manifest.py"))
release_server = load("release_server", os.path.join(ROOT, "tests/vm/release_server.py"))
slots = update.slots

update.log = lambda message: None
slots.log = lambda message: None

GPG = shutil.which("gpg")
GPGV = shutil.which("gpgv")
if GPG is None or GPGV is None:
    raise RuntimeError("these tests sign with gpg and verify with gpgv; install both")
CHUNK = 1024 * 1024
RUNNING = "2.6.0"
FLOOR = "2.6.0"


def gpg(home, *args, data=None):
    proc = subprocess.run([GPG, "--homedir", home, "--batch", "--yes", "--pinentry-mode", "loopback",
                           "--passphrase", "", *args],
                          input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace"))
    return proc.stdout


def make_key(name):
    """A fresh signing key in its own home, and its public keyring for gpgv."""
    home = tempfile.mkdtemp(prefix="lk-gpg-")
    gpg(home, "--quick-gen-key", f"{name} <release@example.invalid>", "ed25519", "sign", "never")
    keyring_dir = tempfile.mkdtemp(prefix="lk-keys-")
    with open(os.path.join(keyring_dir, "release.gpg"), "wb") as handle:
        handle.write(gpg(home, "--export"))
    return home, keyring_dir


def drop_key(home, keyring_dir):
    subprocess.run(["gpgconf", "--homedir", home, "--kill", "gpg-agent"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    shutil.rmtree(home)
    shutil.rmtree(keyring_dir)


class Update(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home, cls.keys = make_key("Lab Kiosk test release")
        cls.other_home, cls.other_keys = make_key("Someone else")

    @classmethod
    def tearDownClass(cls):
        drop_key(cls.home, cls.keys)
        drop_key(cls.other_home, cls.other_keys)

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lk-update-")
        self.addCleanup(shutil.rmtree, self.tmp)
        # The image store: the running image, an older one kept for rollback.
        self.root = os.path.join(self.tmp, "root")
        self.boot_dir = os.path.join(self.root, "boot", "grub")
        os.makedirs(self.boot_dir)
        for version in (RUNNING, "2.5.1"):
            folder = os.path.join(self.root, "images", version)
            os.makedirs(folder)
            for name in slots.IMAGE_FILES:
                with open(os.path.join(folder, name), "wb") as handle:
                    handle.write(f"{version} {name}".encode())
        slots.write_env(self.boot_dir, {"current": RUNNING, "previous": "2.5.1"})
        self.releases = os.path.join(self.tmp, "releases")
        os.makedirs(self.releases)

    def publish(self, version, floor=FLOOR, home=None, sizes=(CHUNK + 5, 2 * CHUNK + 1, 3 * CHUNK + 7)):
        """A signed release in releases/<version>/; returns (folder, its files' bytes)."""
        folder = os.path.join(self.releases, version)
        os.makedirs(folder)
        payload = {}
        for name, size in zip(slots.IMAGE_FILES, sizes):
            payload[name] = os.urandom(size)
            with open(os.path.join(folder, name), "wb") as handle:
                handle.write(payload[name])
        manifest = manifests.build_manifest(folder, version, floor, "stable", 1_790_000_000, chunk_size=CHUNK)
        self.write_manifest(folder, manifest, home)
        return folder, payload

    def write_manifest(self, folder, manifest, home=None):
        path = os.path.join(folder, "manifest.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle)
        gpg(home or self.home, "--detach-sign", "-o", path + ".sig", path)

    def serve(self, **options):
        server = release_server.start_in_thread(self.releases, **options)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, f"http://127.0.0.1:{server.server_address[1]}"

    def download(self, url, version, floor=FLOOR, running=RUNNING):
        # The server serves one folder per test; the base URL names the release.
        return update.download(self.root, f"{url}/{version}", running, floor, self.keys, gpgv=GPGV)

    def env(self):
        return slots.read_env(self.boot_dir)

    def tree(self):
        found = []
        for base, dirs, files in os.walk(self.root):
            dirs.sort()
            for name in sorted(files):
                path = os.path.join(base, name)
                with open(path, "rb") as handle:
                    found.append((os.path.relpath(path, self.root), hashlib.sha256(handle.read()).hexdigest()))
        return found

    # ------------------------------------------------------------------

    def test_a_signed_release_is_downloaded_verified_and_moved_into_images(self):
        _, payload = self.publish("2.6.1")
        server, url = self.serve()
        result = update.download(self.root, f"{url}/2.6.1", RUNNING, FLOOR, self.keys, gpgv=GPGV)
        self.assertEqual(result["downloaded"], "2.6.1")
        folder = os.path.join(self.root, "images", "2.6.1")
        for name, data in payload.items():
            with open(os.path.join(folder, name), "rb") as handle:
                self.assertEqual(handle.read(), data)
        self.assertTrue(os.path.isfile(os.path.join(folder, ".verified")))
        self.assertEqual(os.listdir(os.path.join(self.root, "downloads")), [])
        # The rollback image made room, and grubenv no longer names it.
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "images"))), ["2.6.0", "2.6.1"])
        self.assertEqual(self.env(), {"current": RUNNING})

    def test_installing_gives_the_download_one_try(self):
        self.publish("2.6.1")
        _, url = self.serve()
        self.download(url, "2.6.1")
        result = update.install(self.root, "2.6.1", RUNNING, FLOOR, self.keys, gpgv=GPGV)
        self.assertEqual(result, {"next": "2.6.1", "current": RUNNING})
        self.assertEqual(self.env(), {"current": RUNNING, "next": "2.6.1", "next_tries": "1"})

    def test_downloading_again_is_a_no_op(self):
        self.publish("2.6.1")
        _, url = self.serve()
        self.download(url, "2.6.1")
        before = self.tree()
        self.assertTrue(self.download(url, "2.6.1")["already"])
        self.assertEqual(self.tree(), before)

    def test_a_tampered_manifest_is_refused_and_nothing_is_written(self):
        folder, _ = self.publish("2.6.1")
        path = os.path.join(folder, "manifest.json")
        with open(path, "rb") as handle:
            data = handle.read()
        with open(path, "wb") as handle:
            handle.write(data.replace(b'"stable"', b'"beta"  '))
        _, url = self.serve()
        before = self.tree()
        with self.assertRaisesRegex(update.UpdateError, "signature does not verify"):
            self.download(url, "2.6.1")
        self.assertEqual(self.tree(), before)

    def test_a_release_signed_by_another_key_is_refused(self):
        self.publish("2.6.1", home=self.other_home)
        _, url = self.serve()
        before = self.tree()
        with self.assertRaisesRegex(update.UpdateError, "signature does not verify"):
            self.download(url, "2.6.1")
        self.assertEqual(self.tree(), before)

    def test_a_missing_signature_is_refused(self):
        folder, _ = self.publish("2.6.1")
        os.unlink(os.path.join(folder, "manifest.json.sig"))
        _, url = self.serve()
        with self.assertRaisesRegex(update.UpdateError, "could not fetch"):
            self.download(url, "2.6.1")

    def test_an_image_without_keys_refuses_every_release(self):
        self.publish("2.6.1")
        _, url = self.serve()
        empty = os.path.join(self.tmp, "no-keys")
        os.makedirs(empty)
        with self.assertRaisesRegex(update.UpdateError, "no release-signing keys"):
            update.download(self.root, f"{url}/2.6.1", RUNNING, FLOOR, empty, gpgv=GPGV)

    def test_a_validly_signed_release_below_the_floor_is_refused(self):
        self.publish("2.5.9", floor="2.5.0")
        _, url = self.serve()
        before = self.tree()
        with self.assertRaisesRegex(update.UpdateError, "below this workstation's security floor 2.6.0"):
            self.download(url, "2.5.9")
        self.assertEqual(self.tree(), before)

    def test_a_pre_release_of_the_floor_is_below_it(self):
        self.publish("2.6.0-rc1", floor="2.5.0")
        _, url = self.serve()
        with self.assertRaisesRegex(update.UpdateError, "security floor"):
            self.download(url, "2.6.0-rc1")

    def test_the_running_version_is_refused(self):
        self.publish(RUNNING)
        _, url = self.serve()
        with self.assertRaisesRegex(update.UpdateError, "already the image"):
            self.download(url, RUNNING)

    def test_no_download_during_the_one_try(self):
        slots.write_env(self.boot_dir, {"current": "2.5.1", "next": RUNNING, "next_tries": "0"})
        self.publish("2.6.1")
        _, url = self.serve()
        with self.assertRaisesRegex(update.UpdateError, "one try"):
            self.download(url, "2.6.1")

    def test_an_interrupted_download_stays_out_of_images_and_resumes(self):
        _, payload = self.publish("2.6.1")
        # Cut the connection 1.5 chunks into the second file.
        server, url = self.serve(cut_after=CHUNK + CHUNK // 2)
        with self.assertRaisesRegex(update.UpdateError, "download stopped"):
            self.download(url, "2.6.1")
        self.assertFalse(os.path.exists(os.path.join(self.root, "images", "2.6.1")))
        partial = os.path.join(self.root, "downloads", "2.6.1", "initrd.img")
        self.assertEqual(os.path.getsize(partial), CHUNK, "only the verified chunk was written")
        # GRUB's last resort scans images/: the unfinished download is not there.
        self.assertEqual(slots.complete_images(self.root), ["2.6.0"])

        del server.requests[:]
        self.download(url, "2.6.1")
        self.assertIn(("initrd.img", f"bytes={CHUNK}-"), server.requests)
        self.assertNotIn(("vmlinuz", None), server.requests, "a finished file is not fetched again")
        with open(os.path.join(self.root, "images", "2.6.1", "initrd.img"), "rb") as handle:
            self.assertEqual(handle.read(), payload["initrd.img"])

    def test_a_damaged_partial_is_truncated_to_its_last_good_chunk(self):
        _, payload = self.publish("2.6.1")
        # vmlinuz arrives whole; initrd.img stops one byte short of its end.
        server, url = self.serve(cut_after=2 * CHUNK)
        with self.assertRaises(update.UpdateError):
            self.download(url, "2.6.1")
        partial = os.path.join(self.root, "downloads", "2.6.1", "initrd.img")
        self.assertEqual(os.path.getsize(partial), 2 * CHUNK)
        # A bit flipped in the second chunk on disk, as a failing disk might.
        with open(partial, "r+b") as handle:
            handle.seek(CHUNK + 10)
            byte = handle.read(1)
            handle.seek(CHUNK + 10)
            handle.write(bytes([byte[0] ^ 1]))
        del server.requests[:]
        self.download(url, "2.6.1")
        self.assertIn(("initrd.img", f"bytes={CHUNK}-"), server.requests)
        with open(os.path.join(self.root, "images", "2.6.1", "initrd.img"), "rb") as handle:
            self.assertEqual(handle.read(), payload["initrd.img"])

    def test_a_chunk_that_does_not_match_the_manifest_is_never_written(self):
        folder, _ = self.publish("2.6.1")
        path = os.path.join(folder, "initrd.img")
        with open(path, "r+b") as handle:
            handle.seek(CHUNK + 3)
            handle.write(b"X")
        _, url = self.serve()
        with self.assertRaisesRegex(update.UpdateError, "chunk 1 does not match"):
            self.download(url, "2.6.1")
        partial = os.path.join(self.root, "downloads", "2.6.1", "initrd.img")
        self.assertEqual(os.path.getsize(partial), CHUNK)
        self.assertFalse(os.path.exists(os.path.join(self.root, "images", "2.6.1")))

    def test_a_newer_release_replaces_an_unfinished_one(self):
        self.publish("2.6.1")
        self.publish("2.6.2")
        _, url = self.serve(cut_after=CHUNK)
        with self.assertRaises(update.UpdateError):
            self.download(url, "2.6.1")
        self.download(url, "2.6.2")
        self.assertEqual(os.listdir(os.path.join(self.root, "downloads")), [])
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "images"))), ["2.6.0", "2.6.2"])

    def test_a_staged_release_is_replaced_by_a_newer_download(self):
        self.publish("2.6.1")
        self.publish("2.6.2")
        _, url = self.serve()
        self.download(url, "2.6.1")
        update.install(self.root, "2.6.1", RUNNING, FLOOR, self.keys, gpgv=GPGV)
        self.download(url, "2.6.2")
        self.assertEqual(self.env(), {"current": RUNNING})
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "images"))), ["2.6.0", "2.6.2"])

    def test_install_refuses_an_image_that_was_not_downloaded(self):
        # 2.5.1 is a complete image, but no verified download.
        with self.assertRaisesRegex(update.UpdateError, "not a verified download"):
            update.install(self.root, "2.5.1", RUNNING, FLOOR, self.keys, gpgv=GPGV)
        self.assertEqual(self.env(), {"current": RUNNING, "previous": "2.5.1"})

    def test_install_refuses_a_file_changed_after_the_download(self):
        self.publish("2.6.1")
        _, url = self.serve()
        self.download(url, "2.6.1")
        with open(os.path.join(self.root, "images", "2.6.1", "vmlinuz"), "ab") as handle:
            handle.write(b"!")
        with self.assertRaisesRegex(update.UpdateError, "no longer matches"):
            update.install(self.root, "2.6.1", RUNNING, FLOOR, self.keys, gpgv=GPGV)
        self.assertEqual(self.env(), {"current": RUNNING})

    def test_install_refuses_a_manifest_changed_after_the_download(self):
        self.publish("2.6.1")
        _, url = self.serve()
        self.download(url, "2.6.1")
        path = os.path.join(self.root, "images", "2.6.1", "manifest.json")
        with open(path, "rb") as handle:
            data = handle.read()
        with open(path, "wb") as handle:
            handle.write(data + b" ")
        with self.assertRaisesRegex(update.UpdateError, "not verified with the manifest"):
            update.install(self.root, "2.6.1", RUNNING, FLOOR, self.keys, gpgv=GPGV)

    def test_install_enforces_a_floor_raised_since_the_download(self):
        self.publish("2.6.1")
        _, url = self.serve()
        self.download(url, "2.6.1")
        with self.assertRaisesRegex(update.UpdateError, "security floor"):
            update.install(self.root, "2.6.1", RUNNING, "2.7.0", self.keys, gpgv=GPGV)

    def test_status_reports_downloads_and_images(self):
        self.publish("2.6.1")
        _, url = self.serve(cut_after=CHUNK + 10)
        with self.assertRaises(update.UpdateError):
            self.download(url, "2.6.1")
        result = update.status(self.root, RUNNING)
        # All of vmlinuz, and the one verified chunk of initrd.img.
        self.assertEqual(result["downloading"], [{"version": "2.6.1", "bytes": 2 * CHUNK + 5}])
        self.assertEqual(result["images"], [{"version": "2.6.0", "verified": False}])


class Manifest(unittest.TestCase):
    def manifest(self, **changes):
        entry = {"name": "vmlinuz", "size": CHUNK + 1, "sha256": "a" * 64, "chunkSize": CHUNK,
                 "chunks": ["b" * 64, "c" * 64]}
        files = [dict(entry), dict(entry, name="initrd.img"), dict(entry, name="filesystem.squashfs")]
        manifest = {"version": "2.6.1", "channel": "stable", "kind": "feature", "baseVersion": None,
                    "files": files, "securityFloor": "2.6.0", "builtAt": "2026-10-06T00:00:00Z"}
        manifest.update(changes)
        return json.dumps(manifest).encode()

    def test_a_good_manifest_parses(self):
        self.assertEqual(update.validate_manifest(self.manifest())["version"], "2.6.1")

    def test_bad_manifests_are_refused(self):
        good = json.loads(self.manifest())
        entry = good["files"][0]
        cases = {
            "an extra field": dict(good, extra=1),
            "a floor above the version": dict(good, securityFloor="2.6.2"),
            "a version that is a path": dict(good, version="../2.6.1"),
            "an unknown kind": dict(good, kind="hotfix"),
            "a security release with no base": dict(good, kind="security"),
            "a missing file": dict(good, files=good["files"][:2]),
            "a file twice": dict(good, files=[entry, entry, dict(entry, name="initrd.img")]),
            "a file that is not an object": dict(good, files=["vmlinuz", 1, None]),
            "too few chunk hashes": dict(good, files=[dict(entry, chunks=["b" * 64])] + good["files"][1:]),
            "an upper-case hash": dict(good, files=[dict(entry, sha256="A" * 64)] + good["files"][1:]),
            "a tiny chunk size": dict(good, files=[dict(entry, chunkSize=1)] + good["files"][1:]),
            "a size that is a string": dict(good, files=[dict(entry, size="9")] + good["files"][1:]),
            "a size that is a bool": dict(good, files=[dict(entry, size=True)] + good["files"][1:]),
            "a timestamp with a zone": dict(good, builtAt="2026-10-06T00:00:00+05:30"),
        }
        for label, manifest in cases.items():
            with self.subTest(label):
                with self.assertRaises(update.UpdateError):
                    update.validate_manifest(json.dumps(manifest).encode())
        with self.assertRaises(update.UpdateError):
            update.validate_manifest(b"\xff")

    def test_versions_order_as_semver(self):
        ordered = ["1.9.9", "2.6.0-rc.1", "2.6.0-rc.2", "2.6.0-rc.10", "2.6.0-rc1", "2.6.0", "2.6.1", "2.10.0"]
        keys = [update.version_key(version) for version in ordered]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(set(keys)), len(keys))
        with self.assertRaises(update.UpdateError):
            update.version_key("2.6")

    def test_the_tool_writes_what_the_workstation_accepts(self):
        with tempfile.TemporaryDirectory() as live:
            big = manifests.CHUNK_SIZE
            for name, size in zip(slots.IMAGE_FILES, (10, big, 3 * big + 1)):
                with open(os.path.join(live, name), "wb") as handle:
                    handle.write(os.urandom(size))
            out = os.path.join(live, "manifest.json")
            self.assertEqual(manifests.main(["--live", live, "--version", "2.6.1", "--security-floor", "2.6.0",
                                             "--channel", "stable", "--out", out]), 0)
            with open(out, "rb") as handle:
                manifest = update.validate_manifest(handle.read())
        self.assertEqual([len(entry["chunks"]) for entry in manifest["files"]], [1, 1, 4])
        self.assertEqual(manifest["files"][0]["chunkSize"], manifests.CHUNK_SIZE)

    def test_the_tool_and_the_workstation_agree_on_versions(self):
        self.assertEqual(manifests.VERSION_PATTERN.pattern, slots.VERSION_PATTERN.pattern)
        self.assertEqual(manifests.IMAGE_FILES, slots.IMAGE_FILES)


class Image(unittest.TestCase):
    def test_the_security_floor_is_a_version_no_higher_than_the_image(self):
        floor = update.read_security_floor(os.path.join(CHROOT, "usr/share/labkiosk/security-floor"))
        with open(os.path.join(CHROOT, "usr/share/labkiosk/version"), encoding="utf-8") as handle:
            version = handle.read().strip()
        self.assertLessEqual(update.version_key(floor), update.version_key(version))

    def test_the_image_installs_gpgv(self):
        with open(os.path.join(ROOT, "config/package-lists/kiosk.list.chroot"), encoding="utf-8") as handle:
            packages = [line.strip() for line in handle if line.strip() and not line.startswith("#")]
        self.assertIn("gpgv", packages)

    def test_no_raw_string_double_escapes_an_anchor(self):
        for path in (os.path.join(CHROOT, "usr/local/sbin/labkiosk-update"),
                     os.path.join(ROOT, "tools/make-release-manifest.py")):
            with open(path, encoding="utf-8") as handle:
                self.assertNotRegex(handle.read(), r"""r["'][^"'\n]*\\\\Z""")


if __name__ == "__main__":
    unittest.main()
