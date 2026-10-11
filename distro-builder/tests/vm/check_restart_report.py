#!/usr/bin/env python3
"""
Check a restart report labkiosk-logs wrote on the boot-test disk (read on
stdin): a boot switched off without shutting down, with its journal's end.

Prints one line describing it, or exits non-zero naming what is wrong.
"""
import json
import sys

NO_JOURNAL = "No journal entries were kept for this boot."


def main():
    report = json.load(sys.stdin)
    kind = report.get("kind")
    started, ended = report.get("startedAt"), report.get("endedAt")
    log = report.get("log")
    problems = []
    if kind != "unexpected_restart":
        problems.append(f"kind {kind!r}, expected 'unexpected_restart'")
    if not (isinstance(started, int) and isinstance(ended, int) and ended > started):
        problems.append(f"times {started!r}..{ended!r}")
    if not isinstance(log, str) or not log.strip() or log.startswith(NO_JOURNAL):
        problems.append("no journal lines in the report")
    if problems:
        print("; ".join(problems))
        return 1
    print(f"{kind}, {ended - started} s, {len(log.splitlines())} lines of journal")
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main())
