#!/usr/bin/env python3
"""Run the shell steps of one GitHub Actions job outside GitHub Actions.

CircleCI runs the repository's checks from the GitHub workflow files rather
than from a copy of them, so the two cannot drift. For the named job this runs
every step that has a `run:` script, in order, with bash -eo pipefail and the
step's own `env:` block, and skips the `uses:` steps (checkout, setup-node,
pnpm setup), which the CircleCI executor provides instead.

A step whose script or env contains a GitHub expression (${{ ... }}) cannot be
evaluated here, so the script refuses to run the job rather than run the step
with the expression left in place.

Usage: run-actions-job.py WORKFLOW_FILE JOB_ID
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml


def fail(message: str) -> None:
    print(f"run-actions-job: {message}", file=sys.stderr)
    sys.exit(2)


def load_job(workflow_file: Path, job_id: str) -> dict:
    try:
        workflow = yaml.safe_load(workflow_file.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as err:
        fail(f"cannot read {workflow_file}: {err}")
    jobs = workflow.get("jobs") if isinstance(workflow, dict) else None
    if not isinstance(jobs, dict) or job_id not in jobs:
        fail(f"{workflow_file} has no job {job_id!r}")
    job = jobs[job_id]
    if not isinstance(job, dict) or not isinstance(job.get("steps"), list):
        fail(f"job {job_id!r} in {workflow_file} has no steps")
    return job


def check_no_expressions(name: str, value: object) -> None:
    if "${{" in str(value):
        fail(f"step {name!r} uses a GitHub expression, which cannot be evaluated outside GitHub Actions")


def main() -> int:
    if len(sys.argv) != 3:
        fail("usage: run-actions-job.py WORKFLOW_FILE JOB_ID")
    workflow_file, job_id = Path(sys.argv[1]), sys.argv[2]
    job = load_job(workflow_file, job_id)

    runnable = []
    for index, step in enumerate(job["steps"], 1):
        if not isinstance(step, dict):
            fail(f"step {index} of {job_id!r} is not a mapping")
        name = str(step.get("name", f"step {index}"))
        if "run" not in step:
            print(f"skip: {name} (uses: {step.get('uses', '?')})")
            continue
        check_no_expressions(name, step["run"])
        check_no_expressions(name, step.get("env", {}))
        runnable.append((name, str(step["run"]), step.get("env") or {}))
    if not runnable:
        fail(f"job {job_id!r} has no run steps")

    with tempfile.TemporaryDirectory(prefix="runner-temp-") as runner_temp:
        base_env = dict(os.environ, RUNNER_TEMP=runner_temp, CI="true")
        for name, script, step_env in runnable:
            print(f"\n=== {name}", flush=True)
            env = dict(base_env, **{str(k): str(v) for k, v in step_env.items()})
            result = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script], env=env)
            if result.returncode != 0:
                print(f"\nFAILED: {name} (exit {result.returncode})", file=sys.stderr)
                return result.returncode
    print(f"\nok: all {len(runnable)} steps of {job_id} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
