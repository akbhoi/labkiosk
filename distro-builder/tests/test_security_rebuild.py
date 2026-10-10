#!/usr/bin/env python3
"""
distro-builder/tools/security-rebuild.py: which lines are rebuilt, when an
image needs it, the version bump and the release notes (docs/OTA_UPDATES.md
section 7). security-rebuild.yml only runs these steps.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import contextlib
import importlib.machinery
import io
import importlib.util
import itertools
import json
import lzma
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


rebuild = load("security_rebuild", os.path.join(ROOT, "tools", "security-rebuild.py"))
rebuild.log = lambda message: None


def run(args):
    """The command's exit status, its JSON output kept out of the test log."""
    with contextlib.redirect_stdout(io.StringIO()):
        return rebuild.main(args)

STATUS = """\
Package: chromium
Status: install ok installed
Architecture: amd64
Source: chromium
Version: 154.0.8037.92-1~deb12u1
Description: web browser
 a continuation line: Version: 999

Package: libssl3
Status: install ok installed
Architecture: amd64
Source: openssl (3.0.17-1~deb12u2)
Version: 3.0.17-1~deb12u2

Package: tzdata
Status: install ok installed
Architecture: all
Version: 2026c-0+deb12u1

Package: removed-long-ago
Status: deinstall ok config-files
Architecture: amd64
Version: 1.0-1
"""

INDEX = """\
Package: chromium
Architecture: amd64
Version: 154.0.8037.121-1~deb12u1

Package: chromium
Architecture: amd64
Version: 154.0.8037.92-1~deb12u1

Package: libssl3
Architecture: i386
Version: 3.0.18-1~deb12u1

Package: tzdata
Architecture: all
Version: 2026c-0+deb12u1

Package: removed-long-ago
Architecture: amd64
Version: 2.0-1
"""


class Lines(unittest.TestCase):
    def test_the_latest_two_lines_that_update_over_the_air(self):
        tags = ["v2.5.1", "v2.8.0", "v2.9.0", "v2.9.1", "v2.9.2-rc1", "v2.10.0-rc1", "V2.10.0", "v2.10.1", "nightly", "v3"]
        plan = rebuild.plan_lines(tags)
        self.assertEqual(plan, [
            {"line": "2.10", "tag": "v2.10.1", "base": "2.10.1", "version": "2.10.2", "newest": True},
            {"line": "2.9", "tag": "v2.9.1", "base": "2.9.1", "version": "2.9.2", "newest": False},
        ])
        self.assertEqual([entry["line"] for entry in rebuild.plan_lines(tags + ["v2.11.0"])], ["2.11", "2.10"])

    def test_a_line_older_than_the_updater_is_never_rebuilt(self):
        self.assertEqual(rebuild.plan_lines(["v2.7.0", "v2.8.0"]), [])
        self.assertEqual([entry["tag"] for entry in rebuild.plan_lines(["v2.8.0", "v2.9.0"])], ["v2.9.0"])

    def test_one_line_by_hand(self):
        tags = ["v2.9.0", "v2.10.0"]
        self.assertEqual([entry["line"] for entry in rebuild.plan_lines(tags, "2.9")], ["2.9"])
        for line in ("2.8", "2.9.0", "../2"):
            with self.subTest(line=line):
                with self.assertRaises(ValueError):
                    rebuild.plan_lines(tags, line)


class DebianVersions(unittest.TestCase):
    ORDERED = [
        "1.0~rc1", "1.0~rc1-1", "1.0", "1.0-0.1", "1.0-1", "1.0-1+b1", "1.0-1+deb12u1", "1.0-2~bpo1",
        "1.0-2", "1.0a", "1.0+dfsg", "1.0.1", "1.1~~", "1.1~", "1.1", "1.10", "2:0.1", "2:0.1-1",
    ]

    def test_versions_order_as_dpkg_orders_them(self):
        for lower, higher in zip(self.ORDERED, self.ORDERED[1:]):
            with self.subTest(lower=lower, higher=higher):
                self.assertEqual(rebuild.compare_debian_versions(lower, higher), -1)
                self.assertEqual(rebuild.compare_debian_versions(higher, lower), 1)
        self.assertEqual(rebuild.compare_debian_versions("0:1.0-1", "1.0-1"), 0)
        self.assertEqual(rebuild.compare_debian_versions("154.0.8037.121-1~deb12u1", "154.0.8037.92-1~deb12u1"), 1)

    @unittest.skipUnless(shutil.which("dpkg"), "needs dpkg to compare against")
    def test_the_same_answers_as_dpkg_itself(self):
        samples = self.ORDERED + ["3.0.17-1~deb12u2", "3.0.17-1~deb12u3", "2026c-0+deb12u1", "1:2.38.1-5+deb12u3",
                                  "6.1.0-37", "6.1.0-37+b1", "20230210+ds-1", "0.0~git20230101.1-1"]
        for a, b in itertools.combinations(samples, 2):
            if rebuild.compare_debian_versions(a, b) < 0:
                expected = "lt"
            elif rebuild.compare_debian_versions(a, b) > 0:
                expected = "gt"
            else:
                expected = "eq"
            with self.subTest(a=a, b=b):
                self.assertEqual(subprocess.run(["dpkg", "--compare-versions", a, expected, b]).returncode, 0)

    def test_garbage_is_not_a_version(self):
        for value in ("", "abc", "1.0 2", "-1"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    rebuild.compare_debian_versions(value, "1.0")


class Check(unittest.TestCase):
    def test_installed_packages_with_a_newer_version_in_the_archive(self):
        found = rebuild.outdated(rebuild.installed_packages(STATUS), rebuild.newest_in_index([INDEX]))
        self.assertEqual(found, [{
            "package": "chromium", "architecture": "amd64", "installed": "154.0.8037.92-1~deb12u1",
            "available": "154.0.8037.121-1~deb12u1", "source": "chromium",
        }], "another architecture, an equal version and a package no longer installed are not updates")

    def test_the_source_package_is_named(self):
        self.assertEqual(rebuild.installed_packages(STATUS)[("libssl3", "amd64")], ("3.0.17-1~deb12u2", "openssl"))

    def test_an_empty_status_is_an_error_not_up_to_date(self):
        with self.assertRaises(ValueError):
            rebuild.installed_packages("")

    def test_the_command_reads_xz_indices_and_fails_a_stale_rebuild(self):
        with tempfile.TemporaryDirectory() as tmp:
            status = os.path.join(tmp, "status")
            index = os.path.join(tmp, "Packages.xz")
            with open(status, "w", encoding="utf-8") as handle:
                handle.write(STATUS)
            with open(index, "wb") as handle:
                handle.write(lzma.compress(INDEX.encode()))
            args = ["check", "--status", status, "--index", index]
            self.assertEqual(run(args), 0)
            self.assertEqual(run(args + ["--fail-if-outdated"]), 2)
            self.assertEqual(run(["check", "--status", status, "--mirror", "http://deb.debian.org/debian-security"]), 1,
                             "the archive is read over https only")


class Bump(unittest.TestCase):
    def tree(self):
        tmp = tempfile.mkdtemp(prefix="lk-bump-")
        self.addCleanup(shutil.rmtree, tmp)
        for name in (rebuild.VERSION_FILE, rebuild.AGENT_FILE, rebuild.EXTENSION_MANIFEST, rebuild.WORKER_PACKAGE):
            os.makedirs(os.path.dirname(os.path.join(tmp, name)), exist_ok=True)
            shutil.copyfile(os.path.join(REPO, name), os.path.join(tmp, name))
        return tmp

    def test_the_four_files_of_this_repository_are_bumped_together(self):
        tmp = self.tree()
        base = set(rebuild.read_versions(tmp).values())
        self.assertEqual(len(base), 1, "the repository carries one version everywhere")
        base = base.pop()
        major, minor, patch = base.split("-")[0].split(".")
        target = f"{major}.{minor}.{int(patch) + 1}"
        self.assertEqual(run(["bump", "--root", tmp, "--from", base, "--to", target]), 0)
        self.assertEqual(set(rebuild.read_versions(tmp).values()), {target})
        with open(os.path.join(tmp, rebuild.EXTENSION_MANIFEST), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["version"], target, "still valid JSON")
        with open(os.path.join(tmp, rebuild.VERSION_FILE), "rb") as handle:
            self.assertEqual(handle.read(), target.encode() + b"\n")

    def test_a_tree_that_does_not_carry_the_base_is_left_alone(self):
        tmp = self.tree()
        before = rebuild.read_versions(tmp)
        self.assertEqual(run(["bump", "--root", tmp, "--from", "0.0.1", "--to", "0.0.2"]), 1)
        self.assertEqual(rebuild.read_versions(tmp), before)


class Notes(unittest.TestCase):
    def test_the_notes_list_what_changed(self):
        rebuilt = STATUS.replace("154.0.8037.92-1~deb12u1", "154.0.8037.121-1~deb12u1")
        text = rebuild.notes("v2.9.0", "2.9.1", STATUS, rebuilt)
        self.assertIn("Security rebuild of v2.9.0", text)
        self.assertIn("| `chromium` | `154.0.8037.92-1~deb12u1` | `154.0.8037.121-1~deb12u1` |", text)
        self.assertNotIn("tzdata", text)
        self.assertIn("No package changed", rebuild.notes("v2.9.0", "2.9.1", STATUS, STATUS))


class Workflow(unittest.TestCase):
    """security-rebuild.yml runs the steps above, and publishes only what passed them."""

    def setUp(self):
        with open(os.path.join(REPO, ".github", "workflows", "security-rebuild.yml"), encoding="utf-8") as handle:
            self.workflow = handle.read()

    def test_it_runs_daily_and_by_hand_with_a_dry_run(self):
        self.assertIn("schedule:", self.workflow)
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertIn("dry_run:", self.workflow)

    def test_the_rebuild_is_checked_signed_and_boot_tested_before_it_is_published(self):
        order = ["security-rebuild.py check", "--fail-if-outdated", "boot-test.sh", "--kind security",
                 "gpgv", "aws s3 cp", "git push", "softprops/action-gh-release", "/api/release-notes/sync"]
        positions = [self.workflow.find(step) for step in order]
        self.assertNotIn(-1, positions, dict(zip(order, positions)))
        self.assertEqual(positions, sorted(positions), "each step comes after the one it depends on")

    def test_the_github_release_carries_the_package_list_and_no_iso(self):
        start = self.workflow.index("- name: Create GitHub Release")
        step = self.workflow[start:self.workflow.index("- name:", start + 1)]
        self.assertIn("files: ${{ runner.temp }}/rebuilt/dpkg-status", step)
        self.assertIn('make_latest: "false"', step, "GitHub's latest stays the newest release with an ISO")
        self.assertNotIn(".iso", step)
        self.assertIn("--pattern dpkg-status", self.workflow, "the next run reads a security release's packages from it")


if __name__ == "__main__":
    unittest.main()
