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
ARCHITECTURES = ("amd64", "arm64")


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
        self.assertIn("needs: [build-iso, boot-test, smoke-test-arm64, raspi-image]", release)
        for step in ("Sign the over-the-air release", "Upload the over-the-air release to R2",
                     "Create GitHub Release"):
            self.assertIn(step, release)
            self.assertNotIn(step, iso.split("\n  release:\n", 1)[0])

    def test_every_architecture_is_built_tested_and_released(self):
        iso = read_workflow("build-iso.yml")
        build, rest = iso.split("\n  boot-test:\n", 1)
        release = rest.split("\n  release:\n", 1)[1]
        for arch in ARCHITECTURES:
            self.assertIn(f"arch: {arch}", build)
            self.assertIn(f"labkiosk-debian13-{arch}-iso", release)
            self.assertIn(f"distro-builder/out/labkiosk-debian13-{arch}.iso\n", release)
            self.assertIn(f"distro-builder/out/labkiosk-debian13-{arch}.iso.sha256\n", release)
        self.assertIn("for arch in amd64 arm64; do", release)
        self.assertIn('--architecture "$arch"', release)
        self.assertNotIn("debian12", iso)

    def test_the_raspberry_pi_card_is_built_from_the_tested_arm64_iso_and_released(self):
        iso = read_workflow("build-iso.yml")
        job = iso.split("\n  raspi-image:\n", 1)[1].split("\n  release:\n", 1)[0]
        self.assertIn("needs: [build-iso, smoke-test-arm64]", job)
        self.assertIn("apt-get download raspi-firmware", job, "apt checks the firmware's signature")
        self.assertIn("tools/labkiosk-raspi.py build", job)
        release = iso.split("\n  release:\n", 1)[1]
        for name in ("labkiosk-debian13-raspi-arm64.img.xz\n", "labkiosk-debian13-raspi-arm64.img.xz.sha256\n"):
            self.assertIn(f"distro-builder/out/{name}", release)

    def test_the_release_page_says_which_file_to_download_and_how_to_install_it(self):
        release = read_workflow("build-iso.yml").split("\n  release:\n", 1)[1]
        self.assertIn("body_path: ${{ runner.temp }}/release-body.md", release)
        self.assertIn("generate_release_notes: true", release, "GitHub's change list follows the guide")
        self.assertLess(release.index("Write the release notes"), release.index("Create GitHub Release"))
        with open(os.path.join(REPO, ".github", "release-body.md"), encoding="utf-8") as handle:
            body = handle.read()
        downloads = [f"labkiosk-debian13-{arch}.iso" for arch in ARCHITECTURES] + ["labkiosk-debian13-raspi-arm64.img.xz"]
        for name in downloads:
            self.assertIn(f"distro-builder/out/{name}\n", release, "the guide names only files the release has")
            self.assertIn(f"https://github.com/akbhoi/labkiosk/releases/download/@VERSION@/{name})", body)
        for heading in ("## Which file do I need?", "## System requirements", "## How to install", "## Verify the download",
                        "## Updating"):
            self.assertIn(heading, body)
        with open(os.path.join(REPO, "cloudflare-control", "src", "release_notes.ts"), encoding="utf-8") as handle:
            marker = re.search(r'CHANGE_LIST_MARKER = "([^"]+)"', handle.read()).group(1)
        self.assertTrue(body.rstrip().endswith(marker), "the controller reads only what follows the guide")

    def test_other_architectures_reach_r2_before_the_amd64_manifest(self):
        # The controller records a release's architectures when it first sees
        # the root (amd64) manifest, so every subfolder must already be there.
        release = read_workflow("build-iso.yml").split("\n  release:\n", 1)[1]
        upload = release.split("Upload the over-the-air release to R2", 1)[1].split("\n      - name:", 1)[0]
        self.assertIn("for arch in arm64 amd64; do", upload)
        self.assertIn('[ "$arch" = amd64 ] || folder="$prefix/$arch"', upload)
        self.assertLess(upload.index("filesystem.squashfs"), upload.index("manifest.json.sig manifest.json"))

    def test_the_smoke_test_is_shellchecked(self):
        self.assertIn("distro-builder/tests/vm/live-smoke-test.sh", read_workflow("ci.yml"))

    def test_the_boot_test_jobs_cover_every_group(self):
        iso = read_workflow("build-iso.yml")
        groups = re.findall(r"^\s+groups: (\S+)$", iso, re.MULTILINE)
        covered = sorted(g for entry in groups for g in entry.split(","))
        with open(os.path.join(REPO, "distro-builder", "tests", "vm", "boot-test.sh"), encoding="utf-8") as handle:
            known = re.search(r'^ALL_GROUPS="([a-z ]+)"$', handle.read(), re.MULTILINE).group(1).split()
        self.assertEqual(covered, sorted(known))


if __name__ == "__main__":
    unittest.main()
