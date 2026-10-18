#!/usr/bin/env python3
"""
.github/workflows: every third-party action is pinned to a full commit SHA.

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


if __name__ == "__main__":
    unittest.main()
