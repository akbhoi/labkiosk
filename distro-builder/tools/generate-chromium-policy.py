#!/usr/bin/env python3
"""
Regenerate the boot-time Chromium managed policy from its single base.

The static policy is declared exactly once, in
config/includes.chroot/usr/share/labkiosk/chromium-policy-base.json. Two
consumers read it:

  * The agent, at runtime, on every allowlist change (sync_chromium_policies).
  * config/hooks/live/01-lockdown.hook.chroot, at ISO build time.

config/includes.chroot/etc/chromium/policies/managed/policies.json is a
*generated* artifact committed to the repository, because the Docker simulator
copies that directory directly and never runs the live-build hook. Treat it the
way you would a lockfile: never hand-edit it, regenerate it here.

    python3 tools/generate-chromium-policy.py            # rewrite it
    python3 tools/generate-chromium-policy.py --check    # fail if it is stale
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "config/includes.chroot/usr/share/labkiosk/chromium-policy-base.json"
OUT = ROOT / "config/includes.chroot/etc/chromium/policies/managed/policies.json"

# Kept in step with SETUP_URL in opt/labkiosk/agent/agent.py.
SETUP_URL = "http://127.0.0.1:8888/setup"

# Deliberately minimal. The organization's real allowlist arrives with the first
# telemetry response. Broad entries such as workers.dev were removed: anyone can
# deploy a proxy on a free *.workers.dev subdomain, which turned the filter into
# a formality.
BOOT_ALLOWLIST = ["127.0.0.1", "localhost", "file:///opt/labkiosk/*"]


def render() -> str:
    policy = json.loads(BASE.read_text(encoding="utf-8"))
    policy["_generated_comment"] = (
        "GENERATED FILE -- do not edit. Produced by tools/generate-chromium-policy.py "
        "from usr/share/labkiosk/chromium-policy-base.json. Edit the base instead, "
        "then re-run that script."
    )
    policy["HomepageLocation"] = SETUP_URL
    policy["NewTabPageLocation"] = SETUP_URL
    policy["URLAllowlist"] = list(BOOT_ALLOWLIST)
    return json.dumps(policy, indent=2) + "\n"


def main() -> int:
    if not BASE.is_file():
        print(f"error: missing policy base at {BASE}", file=sys.stderr)
        return 2

    rendered = render()
    check_only = "--check" in sys.argv[1:]

    if check_only:
        current = OUT.read_text(encoding="utf-8") if OUT.is_file() else ""
        if current != rendered:
            print(
                f"error: {OUT.relative_to(ROOT)} is out of date with the policy base.\n"
                f"       Run: python3 tools/generate-chromium-policy.py",
                file=sys.stderr,
            )
            return 1
        print(f"ok: {OUT.relative_to(ROOT)} matches the policy base")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(rendered, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
