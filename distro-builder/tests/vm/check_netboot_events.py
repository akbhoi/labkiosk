#!/usr/bin/env python3
"""
boot-test.sh, scenarios 12-14: read netboot_server.py's events on stdin and
print the client id of the first heartbeat sent with a token issued to it at
enrolment. Exits 1 while there is none yet.
"""
import json
import sys


def main():
    events = [json.loads(line) for line in sys.stdin if line.strip()]
    enrolled = {e["clientId"] for e in events if e.get("event") == "enrolled"}
    beats = [e["clientId"] for e in events if e.get("event") == "telemetry" and e.get("clientId") in enrolled]
    if not beats:
        return 1
    print(beats[0])
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main())
