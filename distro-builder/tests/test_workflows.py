#!/usr/bin/env python3
"""
.github/workflows: every third-party action is pinned to a full commit SHA, and
nothing is deployed or released before the checks of the same run passed.

The deploy and release jobs hold the Cloudflare token, the R2 keys and the update
signing key, so a moved tag on any action they run would reach every workstation.
Dependabot (.github/dependabot.yml) keeps the pins and their version comments current.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import os
import re
import sys
import unittest

sys.dont_write_bytecode = True

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORKFLOWS = os.path.join(REPO, ".github", "workflows")
USES = re.compile(r"^\s*-?\s*uses:\s*(\S+)(.*)$")
PINNED = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}\Z")
VERSION_COMMENT = re.compile(r"^\s*#\s*v?\d+\.\d+\.\d+\s*\Z")


class ActionsArePinned(unittest.TestCase):
    def test_every_action_is_pinned_to_a_commit(self):
        files = sorted(f for f in os.listdir(WORKFLOWS) if f.endswith((".yml", ".yaml")))
        self.assertTrue(files, "no workflows found")
        seen = 0
        for name in files:
            with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as handle:
                for number, line in enumerate(handle, 1):
                    match = USES.match(line)
                    if not match:
                        continue
                    seen += 1
                    action, rest = match.group(1), match.group(2)
                    where = f"{name}:{number}"
                    # Local actions (./path) and container images are not fetched by tag.
                    if action.startswith("./") or action.startswith("docker://"):
                        continue
                    self.assertRegex(action, PINNED, f"{where}: pin {action} to a 40-character commit SHA")
                    self.assertRegex(rest, VERSION_COMMENT, f"{where}: follow the SHA with its version, e.g. '# v7.0.1'")
        self.assertGreater(seen, 0, "no uses: lines found")

    def test_dependabot_updates_the_pins(self):
        with open(os.path.join(REPO, ".github", "dependabot.yml"), encoding="utf-8") as handle:
            self.assertIn("package-ecosystem: github-actions", handle.read())


def read_workflow(name):
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as handle:
        return handle.read()


class NothingUntestedIsPublished(unittest.TestCase):
    """The deploy and the release run only after the checks of the same run passed."""

    def test_the_control_plane_deploys_only_from_ci_after_its_tests(self):
        deploy = read_workflow("deploy-cloudflare.yml")
        triggers = deploy.split("\non:\n", 1)[1].split("\n\n", 1)[0]
        self.assertEqual(triggers.split(), ["workflow_call:"], "deploy-cloudflare.yml must run only when ci.yml calls it")
        ci = read_workflow("ci.yml")
        job = ci.split("\n  deploy:\n", 1)[1]
        self.assertIn("needs: [changes, worker]", job)
        self.assertIn("uses: ./.github/workflows/deploy-cloudflare.yml", job)
        self.assertIn("github.ref == 'refs/heads/main'", job)

    def test_a_push_to_main_never_cancels_a_running_deploy(self):
        ci = read_workflow("ci.yml")
        self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", ci)

    def test_the_release_waits_for_every_boot_test_job(self):
        iso = read_workflow("build-iso.yml")
        release = iso.split("\n  release:\n", 1)[1]
        self.assertIn("needs: [build-iso, boot-test]", release)
        for step in ("Sign the over-the-air release", "Upload the over-the-air release to R2",
                     "Create GitHub Release"):
            self.assertIn(step, release)
            self.assertNotIn(step, iso.split("\n  release:\n", 1)[0])

    def test_the_boot_test_jobs_cover_every_group(self):
        iso = read_workflow("build-iso.yml")
        groups = re.findall(r"^\s+groups: (\S+)$", iso, re.MULTILINE)
        covered = sorted(g for entry in groups for g in entry.split(","))
        with open(os.path.join(REPO, "distro-builder", "tests", "vm", "boot-test.sh"), encoding="utf-8") as handle:
            known = re.search(r'^ALL_GROUPS="([a-z ]+)"$', handle.read(), re.MULTILINE).group(1).split()
        self.assertEqual(covered, sorted(known))


if __name__ == "__main__":
    unittest.main()
