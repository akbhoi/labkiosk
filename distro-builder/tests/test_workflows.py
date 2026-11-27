#!/usr/bin/env python3
"""
.github/workflows: every third-party action is pinned to a full commit SHA, and
nothing is deployed or released before the checks of the same run passed. The
Workers are deployed by Cloudflare Workers Builds, through a script that runs
their checks first.

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

    def test_no_workflow_deploys_a_worker(self):
        # The Workers are deployed by Cloudflare Workers Builds alone, through
        # workers-builds-deploy.sh. A second deploy from a workflow could run
        # its migrations alongside that one.
        for name in sorted(f for f in os.listdir(WORKFLOWS) if f.endswith((".yml", ".yaml"))):
            text = read_workflow(name)
            self.assertNotIn("wrangler deploy", text, f"{name} deploys a Worker; Workers Builds does that")
            self.assertNotIn("d1 migrations apply", text, f"{name} migrates D1; Workers Builds does that")

    def test_the_workers_deploy_only_after_their_tests(self):
        with open(os.path.join(REPO, "cloudflare-control", "scripts", "workers-builds-deploy.sh"),
                  encoding="utf-8") as handle:
            script = handle.read()
        self.assertIn("set -euo pipefail", script)
        body = script.split("\ncheck \"$control\"\n", 1)
        self.assertEqual(len(body), 2, "the script must check the control plane before anything else")
        before, after = body
        self.assertNotIn("wrangler deploy", before)
        self.assertNotIn("migrations apply", before)
        order = [after.index(step) for step in (
            'check "$email"',
            "wrangler d1 migrations apply labkiosk-db --remote",
            'pnpm --dir "$control" exec wrangler deploy',
            'pnpm --dir "$email" exec wrangler deploy',
        )]
        self.assertEqual(order, sorted(order), "check both Workers, migrate, then deploy the controller before the email Worker")
        for step in ("install --frozen-lockfile", "run typecheck", "test"):
            self.assertIn(f'pnpm --dir "$1" {step}', script)

    def test_every_change_to_a_worker_starts_its_tests(self):
        workers = read_workflow("workers.yml")
        triggers = workers.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        for path in ("cloudflare-control/**", "cloudflare-email-routing/**", "wiki/**",
                     ".github/workflows/workers.yml"):
            self.assertEqual(triggers.count(f'- "{path}"'), 2, f"{path} must start both push and pull_request runs")

    def test_circleci_runs_the_workflow_jobs_themselves(self):
        # CircleCI runs the checks from the workflow files, not from a copy.
        with open(os.path.join(REPO, ".circleci", "config.yml"), encoding="utf-8") as handle:
            config = handle.read()
        for workflow, job in (("workers.yml", "control-plane"), ("workers.yml", "email-worker"),
                              ("client.yml", "tests"), ("client.yml", "lint")):
            self.assertIn(f"{{ workflow: {workflow}, job: {job} }}", config)
            self.assertIn(f"\n  {job}:\n", read_workflow(workflow), f"{workflow} has no job {job}")

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
        self.assertIn("distro-builder/tests/vm/live-smoke-test.sh", read_workflow("client.yml"))

    def test_a_security_rebuild_installs_what_the_boot_test_needs(self):
        def packages(name, step):
            workflow = read_workflow(name)
            start = workflow.index(f"- name: {step}")
            end = workflow.find("\n      - ", start)  # the next step, so a later step's install never counts
            command = re.search(r"apt-get install -y --no-install-recommends ((?:\\\n|[^\n])+)",
                                workflow[start:end if end != -1 else len(workflow)])
            self.assertIsNotNone(command, f"{name}: no apt-get install in '{step}'")
            return set(command.group(1).replace("\\\n", " ").split()) - {"\\"}

        needed = packages("build-iso.yml", "Boot-test the installed disk")
        installed = packages("security-rebuild.yml", "Boot-test the installed disk")
        self.assertIn("python3-virt-firmware", needed)
        self.assertLessEqual(needed, installed, "the security rebuild runs the same boot test")

    def test_the_boot_test_jobs_cover_every_group(self):
        iso = read_workflow("build-iso.yml")
        groups = re.findall(r"^\s+groups: (\S+)$", iso, re.MULTILINE)
        covered = sorted(g for entry in groups for g in entry.split(","))
        with open(os.path.join(REPO, "distro-builder", "tests", "vm", "boot-test.sh"), encoding="utf-8") as handle:
            known = re.search(r'^ALL_GROUPS="([a-z ]+)"$', handle.read(), re.MULTILINE).group(1).split()
        self.assertEqual(covered, sorted(known))


if __name__ == "__main__":
    unittest.main()
