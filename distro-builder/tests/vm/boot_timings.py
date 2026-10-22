#!/usr/bin/env python3
"""
boot-test.sh, step 4b: where a boot's time went, read from the journal on
DATA (journalctl --output=json on stdin). For the last boot it prints systemd's
"Startup finished" split, when the kiosk session started, and how long each
labkiosk-* service took from "Starting" to "Started"/"Finished", slowest first.

It measures; it does not judge. The numbers are from a KVM guest on a CI
runner, so compare them between runs of this test, never with real hardware.
"""
import json
import sys

STARTING = "7d4958e842da4a758f6c1cdc7b36dcc5"
STARTED = "39f53479d3a045ac8e11786248231fbf"
STARTUP_FINISHED = "b07a249cd024414a82dd00cd181378ff"
SESSION_UNIT = "labkiosk-session.service"


def seconds(usec):
    return f"{int(usec) / 1e6:6.2f} s"


def main():
    records = []
    for line in sys.stdin:
        line = line.strip()
        if line:
            records.append(json.loads(line))
    if not records:
        print("no journal records")
        return 1
    last_boot = records[-1].get("_BOOT_ID")
    boot = [r for r in records if r.get("_BOOT_ID") == last_boot and r.get("_PID") == "1"]

    finished = next((r for r in boot if r.get("MESSAGE_ID") == STARTUP_FINISHED), None)
    if finished:
        print(f"startup: kernel {seconds(finished.get('KERNEL_USEC', 0))}, "
              f"initrd {seconds(finished.get('INITRD_USEC', 0))}, "
              f"userspace {seconds(finished.get('USERSPACE_USEC', 0))}")
    else:
        print("startup: systemd logged no 'Startup finished' (a unit was still starting when the journal was read)")

    starting, durations = {}, []
    session_started = None
    for record in boot:
        unit = record.get("UNIT", "")
        when = int(record["__MONOTONIC_TIMESTAMP"])
        if record.get("MESSAGE_ID") == STARTING:
            starting[unit] = when
        elif record.get("MESSAGE_ID") == STARTED:
            if unit == SESSION_UNIT:
                session_started = when
            if unit.startswith("labkiosk-") and unit in starting:
                durations.append((when - starting[unit], unit, starting[unit]))
    if session_started is not None:
        print(f"kiosk session started {seconds(session_started)} after the kernel")
    for took, unit, began in sorted(durations, reverse=True):
        print(f"  {unit:40} {seconds(took)}  (began at {seconds(began)})")
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main())
