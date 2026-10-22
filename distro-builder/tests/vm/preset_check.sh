#!/bin/sh
# boot-test.sh, group preset: runs inside a live session started from an ISO
# customized with tools/labkiosk-iso.py (boot-test.sh puts it on a test copy
# of that ISO at /labkiosk-test/check.sh; live-smoke-test.sh runs it as root).
#
# It checks what the agent did with the stick's settings on its own, then
# presses Install the way the wizard's button does (POST /api/install, with no
# password: the stick's is used), waits for the installer to finish and prints
# the marker. boot-test.sh then boots the installed disk.
#
# The expected values are boot-test.sh's PRESET_ORG and PRESET_TIMEZONE.
set -u

EXPECT_ORG=preset-test
EXPECT_TIMEZONE=Europe/Berlin
TARGET=/dev/vda
API=http://127.0.0.1:8888

say() { echo "[preset-check] $*"; }
fail() { say "FAIL $*"; exit 1; }

say "waiting for the agent to apply the stick's settings"
until curl -sf --max-time 20 "$API/api/status" -o /tmp/preset-status.json \
        && python3 -c 'import json, sys; p = json.load(open(sys.argv[1])).get("preset"); sys.exit(0 if p and not p.get("applying") else 1)' /tmp/preset-status.json; do
    sleep 5
done

python3 - "$EXPECT_ORG" /tmp/preset-status.json <<'PY' || exit 1
import json, sys
preset = json.load(open(sys.argv[2]))["preset"]
print("[preset-check] the wizard is told:", json.dumps(preset))
if preset.get("error") or preset["organization"] != sys.argv[1] or preset["problems"] or not preset["bootPassword"]:
    sys.exit("[preset-check] FAIL the preset is not as written")
PY
say "PASS the agent read the stick: organization $EXPECT_ORG, no problems"

mode="$(stat -c %a /etc/labkiosk/preset-enrolment.json 2>/dev/null)" || fail "no /etc/labkiosk/preset-enrolment.json"
[ "$mode" = 600 ] || fail "preset-enrolment.json has mode $mode, not 600"
grep -q "\"subdomain\": \"$EXPECT_ORG\"" /etc/labkiosk/preset-enrolment.json || fail "preset-enrolment.json names another organization"
say "PASS the enrolment is kept for the installed system (mode 600)"

case "$(readlink /etc/localtime)" in
    *"/$EXPECT_TIMEZONE") say "PASS the time zone is $EXPECT_TIMEZONE" ;;
    *) fail "the time zone is $(readlink /etc/localtime), not $EXPECT_TIMEZONE" ;;
esac
grep -q "\"timezone\": \"$EXPECT_TIMEZONE\"" /etc/labkiosk/localization.json || fail "localization.json was not saved"

say "pressing Install: $TARGET"
reply="$(curl -s --max-time 30 -X POST -H 'Content-Type: application/json' \
    -d "{\"targetDisk\": \"$TARGET\"}" -w ' %{http_code}' "$API/api/install")"
case "$reply" in
    *' 200') say "the install started: $reply" ;;
    *) fail "POST /api/install answered $reply" ;;
esac

last=""
while :; do
    sleep 10
    st="$(curl -sf --max-time 20 "$API/api/install/status")" || continue
    [ "$st" != "$last" ] && say "install: $st"
    last="$st"
    state="$(printf '%s' "$st" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("state", ""))')" || continue
    case "$state" in
        completed) break ;;
        error) fail "the installer failed" ;;
    esac
done
say "PASS installed"
echo labkiosk-smoke-ok | tr "[:lower:]" "[:upper:]"
