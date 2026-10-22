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

    def test_with_the_platform_policy_every_line_of_a_major_not_ended(self):
        tags = ["v2.9.0", "v2.10.0", "v3.0.0", "v3.1.0", "v4.0.0"]
        policy = json.dumps({"majors": [
            {"major": 2, "status": "end_of_life", "endOfLifeAt": 1798675200},
            {"major": 3, "status": "security_only", "endOfLifeAt": None},
        ]})
        ended = rebuild.end_of_life_majors(policy)
        self.assertEqual(ended, {2})
        self.assertEqual([entry["line"] for entry in rebuild.plan_lines(tags, end_of_life=ended)], ["4.0", "3.1", "3.0"],
                         "every line of a major still supported gets its fixes; an ended major gets none")
        self.assertEqual([entry["line"] for entry in rebuild.plan_lines(tags, "3.0", end_of_life=ended)], ["3.0"])
        with self.assertRaisesRegex(ValueError, "end of life"):
            rebuild.plan_lines(tags, "2.10", end_of_life=ended)
        self.assertEqual(rebuild.plan_lines(["v2.9.0", "v2.10.0"], end_of_life={2}), [])

    def test_a_line_superseded_by_a_newer_stable_line_of_its_major_is_not_rebuilt(self):
        tags = ["v3.0.0", "v3.0.1", "v3.1.0", "v4.0.0", "v4.1.0"]
        policy = json.dumps({"majors": [], "stable": ["3.0.0", "3.1.0", "4.0.0"]})
        stable = rebuild.stable_releases(policy)
        self.assertEqual(stable, {(3, 0, 0), (3, 1, 0), (4, 0, 0)})
        plan = rebuild.plan_lines(tags, end_of_life=set(), stable=stable)
        self.assertEqual([entry["line"] for entry in plan], ["4.1", "4.0", "3.1"],
                         "3.1 is stable, so 3.0 is left out; 4.1 is not stable yet, so 4.0 keeps its fixes")
        self.assertEqual([entry["line"] for entry in rebuild.plan_lines(tags, end_of_life=set(), stable={(3, 0, 0)})],
                         ["4.1", "4.0", "3.1", "3.0"], "a line nothing stable supersedes is rebuilt as before")
        self.assertEqual([entry["line"] for entry in rebuild.plan_lines(tags, "3.1", end_of_life=set(), stable=stable)], ["3.1"])
        with self.assertRaisesRegex(ValueError, "superseded by 3.1"):
            rebuild.plan_lines(tags, "3.0", end_of_life=set(), stable=stable)

    def test_a_stable_list_that_cannot_be_read_is_an_error_not_an_empty_one(self):
        for text in ('{"majors": []}', '{"majors": [], "stable": {}}', '{"majors": [], "stable": [3]}',
                     '{"majors": [], "stable": ["3.1"]}', '{"majors": [], "stable": ["3.1.0-rc1"]}',
                     '{"majors": [], "stable": ["v3.1.0"]}', "[]", "not json"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    rebuild.stable_releases(text)

    def test_a_version_already_published_in_r2_is_never_built_again(self):
        # 2.10.1 reached R2 but its tag push was refused: the next rebuild of
        # v2.10.0 is 2.10.2, and the next one of 3.0 skips both 3.0.2 and 3.0.3.
        published = rebuild.published_versions("releases/2.10.1/\nreleases/3.0.0/\n3.0.2\n\nreleases/3.0.3/\n")
        self.assertEqual(published, {"2.10.1", "3.0.0", "3.0.2", "3.0.3"})
        plan = rebuild.plan_lines(["v2.10.0", "v3.0.0", "v3.0.1"], end_of_life=set(), published=published)
        self.assertEqual([(entry["base"], entry["version"]) for entry in plan], [("3.0.1", "3.0.4"), ("2.10.0", "2.10.2")])
        self.assertEqual(rebuild.plan_lines(["v2.10.0", "v2.10.2-rc1"], published=set())[0]["version"], "2.10.1")
        self.assertEqual(rebuild.plan_lines(["v2.10.0", "v2.10.1-rc1"], published=set())[0]["version"], "2.10.1",
                         "a pre-release tag names another version: 2.10.1 is still free")
        for text in ("releases/latest/", "releases/../2.10.1/", "2.10"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    rebuild.published_versions(text)

    def test_the_command_reads_the_published_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "published.txt")
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write("releases/2.10.1/\n")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(rebuild.main(["lines", "--published", path, "v2.10.0"]), 0)
            self.assertEqual([entry["version"] for entry in json.loads(out.getvalue())], ["2.10.2"])
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write("None\n")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(rebuild.main(["lines", "--published", path, "v2.10.0"]), 1)

    def test_a_policy_that_cannot_be_read_is_an_error_not_an_empty_one(self):
        for text in ("", "[]", "{}", '{"majors": {}}', '{"majors": [{"major": 2}]}',
                     '{"majors": [{"major": "2", "status": "supported"}]}',
                     '{"majors": [{"major": true, "status": "supported"}]}',
                     '{"majors": [{"major": -1, "status": "supported"}]}',
                     '{"majors": [{"major": 2, "status": "retired"}]}', '{"majors": [2]}',
                     '{"lines": [{"line": "2.9", "status": "supported"}]}'):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    rebuild.end_of_life_majors(text)

    def test_the_command_reads_the_policy_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "policy.json")
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps({"majors": [{"major": 2, "status": "end_of_life"}], "stable": ["3.0.0", "3.1.0"]}))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(rebuild.main(["lines", "--policy", path, "v2.10.0", "v3.0.0", "v3.1.0"]), 0)
            self.assertEqual([entry["line"] for entry in json.loads(out.getvalue())], ["3.1"])
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps({"majors": []}))
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(rebuild.main(["lines", "--policy", path, "v3.0.0"]), 1,
                                 "a controller that does not list its stable releases stops the run")
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write("not json")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(rebuild.main(["lines", "--policy", path, "v2.9.0"]), 1)


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
        text = rebuild.notes("v2.9.0", "2.9.1", [STATUS], [rebuilt])
        self.assertIn("Security rebuild of v2.9.0", text)
        self.assertIn("| `chromium` | `154.0.8037.92-1~deb12u1` | `154.0.8037.121-1~deb12u1` |", text)
        self.assertNotIn("tzdata", text)
        self.assertIn("No package changed", rebuild.notes("v2.9.0", "2.9.1", [STATUS], [STATUS]))

    def test_a_change_on_every_architecture_is_listed_once(self):
        arm64 = STATUS.replace("Architecture: amd64", "Architecture: arm64")
        fixed = "154.0.8037.121-1~deb12u1"
        text = rebuild.notes("v4.1.0", "4.1.1", [STATUS, arm64],
                             [STATUS.replace("154.0.8037.92-1~deb12u1", fixed),
                              arm64.replace("154.0.8037.92-1~deb12u1", fixed).replace("3.0.17-1~deb12u2", "3.0.18-1")])
        self.assertEqual(text.count("| `chromium` |"), 1)
        self.assertIn("| `libssl3` | `3.0.17-1~deb12u2` | `3.0.18-1` |", text, "a change on one architecture is listed")
        with self.assertRaises(ValueError):
            rebuild.notes("v4.1.0", "4.1.1", [STATUS, arm64], [STATUS])


AUTO_CONFIG_TRIXIE = """\
lb config noauto \\
    --distribution trixie \\
    --parent-distribution trixie \\
    "${@}"
"""
AUTO_CONFIG_BOOKWORM = AUTO_CONFIG_TRIXIE.replace("trixie", "bookworm")
LINE = {"line": "4.1", "tag": "v4.1.0", "base": "4.1.0", "version": "4.1.1", "newest": True}


class Platforms(unittest.TestCase):
    """What each line's own source builds decides its builds, suite and ISO names."""

    def test_a_debian_13_tree_builds_each_architecture_it_defines(self):
        found = rebuild.source_platforms(AUTO_CONFIG_TRIXIE, [
            "arm64/bootloaders", "arm64/packages.list.chroot", "amd64/packages.list.chroot", "amd64/bootloaders",
            "riscv64/packages.list.chroot",
        ])
        self.assertEqual(found, {"suite": "trixie-security", "architectures": [
            {"arch": "amd64", "iso": "labkiosk-debian13-amd64.iso", "runner": "ubuntu-latest"},
            {"arch": "arm64", "iso": "labkiosk-debian13-arm64.iso", "runner": "ubuntu-24.04-arm"},
        ]}, "amd64 first; an architecture without its bootloaders file is not one auto/config builds")

    def test_a_tree_from_before_arm64_builds_debian_12_for_amd64(self):
        self.assertEqual(rebuild.source_platforms(AUTO_CONFIG_BOOKWORM, []), {
            "suite": "bookworm-security",
            "architectures": [{"arch": "amd64", "iso": "labkiosk-debian12-amd64.iso", "runner": "ubuntu-latest"}],
        })

    def test_what_cannot_be_built_here_is_an_error(self):
        for auto_config, paths in (
            ("lb config noauto\n", []),
            (AUTO_CONFIG_TRIXIE.replace("trixie", "forky"), []),
            (AUTO_CONFIG_TRIXIE, ["ppc64el/bootloaders", "ppc64el/packages.list.chroot"]),
            (AUTO_CONFIG_TRIXIE, ["arm64/bootloaders"]),
        ):
            with self.subTest(paths=paths), self.assertRaises(ValueError):
                rebuild.source_platforms(auto_config, paths)

    def test_this_tree_builds_both_architectures_on_debian_13(self):
        found = rebuild.git_platforms(REPO, "HEAD")
        self.assertEqual(found["suite"], "trixie-security")
        self.assertEqual([target["arch"] for target in found["architectures"]], ["amd64", "arm64"])

    def test_every_build_of_a_line_shares_its_version_and_time(self):
        platforms = {"v4.1.0": rebuild.source_platforms(AUTO_CONFIG_TRIXIE, [
            "amd64/bootloaders", "amd64/packages.list.chroot", "arm64/bootloaders", "arm64/packages.list.chroot"]),
            "v4.0.3": rebuild.source_platforms(AUTO_CONFIG_BOOKWORM, [])}
        old = {"line": "4.0", "tag": "v4.0.3", "base": "4.0.3", "version": "4.0.4", "newest": False}
        builds = rebuild.plan_builds([LINE, old], platforms, 1790000000)
        self.assertEqual([(b["version"], b["arch"], b["suite"]) for b in builds], [
            ("4.1.1", "amd64", "trixie-security"), ("4.1.1", "arm64", "trixie-security"),
            ("4.0.4", "amd64", "bookworm-security")])
        self.assertEqual({b["epoch"] for b in builds}, {1790000000})
        self.assertEqual(builds[1]["runner"], "ubuntu-24.04-arm")
        with self.assertRaises(ValueError):
            rebuild.plan_builds([LINE], platforms, 0)


class Decide(unittest.TestCase):
    def setUp(self):
        platforms = {"v4.1.0": rebuild.source_platforms(AUTO_CONFIG_TRIXIE, [
            "amd64/bootloaders", "amd64/packages.list.chroot", "arm64/bootloaders", "arm64/packages.list.chroot"])}
        self.builds = rebuild.plan_builds([LINE], platforms, 1790000000)

    def test_a_fix_on_one_architecture_rebuilds_the_line_on_every_one(self):
        decided = rebuild.decide(self.builds, [{"version": "4.1.1", "arch": "amd64", "outdated": 0},
                                               {"version": "4.1.1", "arch": "arm64", "outdated": 2}])
        self.assertEqual([b["arch"] for b in decided["builds"]], ["amd64", "arm64"])
        self.assertEqual(decided["lines"], [{"line": "4.1", "tag": "v4.1.0", "base": "4.1.0", "version": "4.1.1",
                                             "newest": True, "epoch": 1790000000, "suite": "trixie-security",
                                             "architectures": ["amd64", "arm64"]}])

    def test_a_current_line_is_rebuilt_only_by_hand(self):
        current = [{"version": "4.1.1", "arch": arch, "outdated": 0} for arch in ("amd64", "arm64")]
        self.assertEqual(rebuild.decide(self.builds, current), {"builds": [], "lines": []})
        self.assertEqual(len(rebuild.decide(self.builds, current, force=True)["builds"]), 2)

    def test_a_line_missing_a_check_is_not_rebuilt(self):
        self.assertEqual(rebuild.decide(self.builds, [{"version": "4.1.1", "arch": "amd64", "outdated": 5}],
                                        force=True), {"builds": [], "lines": []})

    def test_an_answer_that_is_not_a_count_is_an_error(self):
        for bad in ({"version": "4.1.1", "arch": "amd64", "outdated": "1"}, {"version": "4.1.1", "arch": "amd64",
                                                                              "outdated": True}, []):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                rebuild.decide(self.builds, [bad])

    def test_the_command_reads_a_folder_of_answers(self):
        with tempfile.TemporaryDirectory() as tmp:
            builds = os.path.join(tmp, "builds.json")
            answers = os.path.join(tmp, "answers")
            os.mkdir(answers)
            with open(builds, "w", encoding="utf-8") as handle:
                json.dump(self.builds, handle)
            for arch, count in (("amd64", 1), ("arm64", 0)):
                with open(os.path.join(answers, f"4.1.1-{arch}.json"), "w", encoding="utf-8") as handle:
                    json.dump({"version": "4.1.1", "arch": arch, "outdated": count}, handle)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(rebuild.main(["decide", "--builds", builds, "--decisions", answers]), 0)
            self.assertEqual(json.loads(out.getvalue())["lines"][0]["architectures"], ["amd64", "arm64"])


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

    def test_the_version_skips_what_r2_already_has(self):
        self.assertIn("--prefix releases/ --delimiter /", self.workflow)
        self.assertIn('--published "$RUNNER_TEMP/published.txt"', self.workflow)
        self.assertLess(self.workflow.index("--prefix releases/"), self.workflow.index("security-rebuild.py lines"))

    def test_the_tag_carries_the_default_branch_workflows(self):
        # GitHub refuses a GITHUB_TOKEN push whose workflow files differ from the default branch's.
        bump = self.workflow.index("security-rebuild.py bump")
        copy = self.workflow.index("cp -a .github/workflows rebuild-src/.github/workflows")
        commit = self.workflow.index("git commit --quiet")
        self.assertLess(bump, copy)
        self.assertLess(copy, commit)
        self.assertIn("git add --all", self.workflow[copy:commit], "a workflow the base lacks is committed too")

    def test_the_github_release_carries_the_package_list_and_no_iso(self):
        start = self.workflow.index("- name: Create GitHub Release")
        step = self.workflow[start:self.workflow.index("- name:", start + 1)]
        self.assertIn("files: ${{ runner.temp }}/package-lists/dpkg-status*", step)
        self.assertIn('make_latest: "false"', step, "GitHub's latest stays the newest release with an ISO")
        self.assertNotIn(".iso", step)
        self.assertIn('asset="dpkg-status-$ARCH"', self.workflow, "the next run reads each architecture's packages")
        self.assertIn('--pattern "$asset"', self.workflow)

    def test_each_build_runs_on_its_architecture_against_its_own_suite(self):
        build = self.workflow.split("\n  build:\n", 1)[1].split("\n  publish:\n", 1)[0]
        self.assertIn("runs-on: ${{ matrix.runner }}", build)
        self.assertIn("platforms: linux/${{ matrix.arch }}", build)
        self.assertIn('--suite "$SUITE" --architecture "$ARCH"', build)
        self.assertIn("if: matrix.arch == 'amd64'", build.split("Boot-test the installed disk", 1)[1][:80])
        self.assertIn("live-smoke-test.sh", build)

    def test_the_builds_of_a_line_make_one_commit_and_publish_together(self):
        self.assertEqual(self.workflow.count('GIT_AUTHOR_DATE="@$EPOCH +0000" GIT_COMMITTER_DATE="@$EPOCH +0000"'), 2,
                         "the build and the publish job commit at the run's one time")
        publish = self.workflow.split("\n  publish:\n", 1)[1]
        self.assertIn('if [ "$(cat "$built")" != "$commit" ]; then', publish)
        self.assertLess(publish.index('!= "$commit"'), publish.index("git tag --annotate"))
        upload = publish.split("Upload the security release to R2", 1)[1].split("\n      - name:", 1)[0]
        self.assertIn('for arch in "${others[@]}" amd64; do', upload, "amd64's root manifest goes up last")

    def test_the_boot_test_gets_its_own_later_fixes_before_it_runs(self):
        apply = self.workflow.index("distro-builder/tests/vm/release-fixes/*.patch;")
        self.assertLess(self.workflow.index("- name: Compile the ISO"), apply, "the image is built before the test changes")
        self.assertLess(apply, self.workflow.index("rebuild-src/distro-builder/tests/vm/boot-test.sh"))
        self.assertIn("apply --check --reverse", self.workflow, "a fix the release already has is skipped")


class ReleaseFixes(unittest.TestCase):
    """Each patch for an older release's boot test changes that test and nothing else."""

    def test_each_patch_touches_only_the_vm_tests(self):
        folder = os.path.join(ROOT, "tests", "vm", "release-fixes")
        patches = sorted(name for name in os.listdir(folder) if name.endswith(".patch"))
        self.assertTrue(patches)
        for name in patches:
            with open(os.path.join(folder, name), encoding="utf-8") as handle:
                paths = [line.split(" ", 3)[2:4] for line in handle if line.startswith("diff --git ")]
            self.assertTrue(paths, name)
            for old, new in paths:
                for path in (old[2:], new.strip()[2:]):
                    self.assertTrue(path.startswith("distro-builder/tests/vm/"), f"{name} changes {path}")

    def test_each_patch_is_already_part_of_this_tree(self):
        folder = os.path.join(ROOT, "tests", "vm", "release-fixes")
        for name in sorted(os.listdir(folder)):
            if not name.endswith(".patch"):
                continue
            result = subprocess.run(["git", "-C", REPO, "apply", "--check", "--reverse", os.path.join(folder, name)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, f"{name} is not on this branch: {result.stderr}")


if __name__ == "__main__":
    unittest.main()
