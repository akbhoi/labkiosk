#!/bin/bash
# Boot test for over-the-air updates, phase 1 (docs/OTA_UPDATES.md section 9).
#
# Installs a built ISO onto a virtual disk with the real installer, then boots
# that disk in QEMU (UEFI, KVM) and checks the one-try boot and the rollback:
#
#   1. promote   a good new image boots once, passes the health check and
#                becomes current; the old one becomes previous
#   2. broken    an image whose squashfs is damaged fails to boot: the machine
#                reboots by itself (panic=10) and the try is spent
#   3. recover   the next boot is the current image again and it stays up
#   4. unhealthy an image that boots but whose kiosk never comes up is
#                rebooted away from after the 10-minute health deadline
#
# The results are read from boot/grub/grubenv on the virtual disk, the same
# file GRUB and labkiosk-boot-slots use. A screenshot of the VM is saved for
# every scenario that fails.
#
# Needs root, /dev/kvm (GitHub's Linux runners have it) and:
#   qemu-system-x86 ovmf xorriso squashfs-tools e2fsprogs fdisk python3
#
# Usage: sudo distro-builder/tests/vm/boot-test.sh path/to/labkiosk-debian12-amd64.iso [workdir]
set -euo pipefail

ISO="${1:?usage: boot-test.sh LABKIOSK.iso [workdir]}"
WORK="${2:-$(dirname "$(readlink -f "$ISO")")/boot-test}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OVMF_CODE=/usr/share/OVMF/OVMF_CODE_4M.fd
OVMF_VARS=/usr/share/OVMF/OVMF_VARS_4M.fd
# The installer refuses less than 7 GiB: room for two images.
DISK_SIZE=8G
# Generous margins over the agent's own numbers (60 s hold, 600 s deadline).
PROMOTE_TIMEOUT=900
BROKEN_TIMEOUT=300
RECOVER_SECONDS=240
UNHEALTHY_MIN=540
UNHEALTHY_TIMEOUT=1200

DISK="$WORK/disk.img"
ROOTFS="$WORK/rootfs"
LIVE="$WORK/live"
STAGE="$WORK/stage"
VM_PID=""
LOOP=""
FAILED=0

log() { printf '[boot-test] %s\n' "$*"; }
die() { printf '[boot-test] ERROR: %s\n' "$*" >&2; exit 2; }
fail() { printf '[boot-test] FAIL %s\n' "$*"; FAILED=1; }
pass() { printf '[boot-test] PASS %s\n' "$*"; }

cleanup() {
    stop_vm
    for mount_point in "$STAGE" "$ROOTFS/run/live/medium/live" "$ROOTFS/run" "$ROOTFS/tmp" \
                       "$ROOTFS/sys" "$ROOTFS/proc" "$ROOTFS/dev"; do
        if mountpoint -q "$mount_point"; then
            umount -R "$mount_point"
        fi
    done
    if [ -n "$LOOP" ]; then
        losetup -d "$LOOP"
    fi
}
trap cleanup EXIT

[ "$(id -u)" = 0 ] || die "run as root: it partitions a loop device and chroots into the image"
[ -f "$ISO" ] || die "no ISO at $ISO"
[ -w /dev/kvm ] || die "/dev/kvm is not available: without KVM the kiosk cannot come up inside the 10-minute health window"
for tool in qemu-system-x86_64 xorriso unsquashfs mksquashfs debugfs sfdisk losetup python3; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
done
[ -f "$OVMF_CODE" ] && [ -f "$OVMF_VARS" ] || die "OVMF firmware not found under /usr/share/OVMF"

rm -rf "$WORK"
mkdir -p "$WORK" "$LIVE" "$STAGE"

# --------------------------------------------------------------------------
# The ISO's system image, and its root filesystem to install from
# --------------------------------------------------------------------------
log "Extracting the live image from $ISO"
xorriso -osirrox on -indev "$ISO" -extract /live "$LIVE" >/dev/null 2>&1
chmod -R u+w "$LIVE"
for name in vmlinuz initrd.img filesystem.squashfs; do
    [ -f "$LIVE/$name" ] || die "the ISO has no live/$name"
done
VERSION="$(unsquashfs -cat "$LIVE/filesystem.squashfs" usr/share/labkiosk/version)"
BASE="${VERSION%%-*}"
V_GOOD="$BASE-t2"
V_BROKEN="$BASE-t3"
V_UNHEALTHY="$BASE-t4"
log "Image version $VERSION; test images $V_GOOD, $V_BROKEN, $V_UNHEALTHY"

log "Unpacking the root filesystem"
unsquashfs -q -f -d "$ROOTFS" "$LIVE/filesystem.squashfs" >/dev/null

# --------------------------------------------------------------------------
# Install with the real installer, from inside the image
# --------------------------------------------------------------------------
log "Installing onto a $DISK_SIZE virtual disk"
truncate -s "$DISK_SIZE" "$DISK"
LOOP="$(losetup -f --show -P "$DISK")"
mount --rbind /dev "$ROOTFS/dev"
mount --make-rslave "$ROOTFS/dev"
mount -t proc proc "$ROOTFS/proc"
mount --rbind /sys "$ROOTFS/sys"
mount --make-rslave "$ROOTFS/sys"
mount -t tmpfs tmpfs "$ROOTFS/run"
mount -t tmpfs tmpfs "$ROOTFS/tmp"
mkdir -p "$ROOTFS/run/live/medium/live"
mount --bind "$LIVE" "$ROOTFS/run/live/medium/live"
install -m 0644 "$HERE/install_into_disk.py" "$ROOTFS/tmp/install_into_disk.py"
chroot "$ROOTFS" /usr/bin/python3 /tmp/install_into_disk.py "$LOOP"
umount -R "$ROOTFS/run" "$ROOTFS/tmp" "$ROOTFS/sys" "$ROOTFS/proc" "$ROOTFS/dev"
losetup -d "$LOOP"
LOOP=""

ROOT_OFFSET="$(sfdisk -J "$DISK" | python3 -c '
import json, sys
table = json.load(sys.stdin)["partitiontable"]
root = [p for p in table["partitions"] if p.get("name") == "ROOT"]
if len(root) != 1:
    sys.exit("expected one partition named ROOT")
print(root[0]["start"] * table.get("sectorsize", 512))
')"

# --------------------------------------------------------------------------
# grubenv, read and written through labkiosk-boot-slots' own functions
# --------------------------------------------------------------------------
SLOTS="$ROOTFS/usr/local/sbin/labkiosk-boot-slots"

# Prints the environment as "key=value ..." in a fixed order. debugfs reads
# the file without mounting, so this works while the VM is running: the boot
# tool remounts the partition read-only after every write, which puts the
# change in place on disk.
env_now() {
    debugfs -R "cat /boot/grub/grubenv" "$DISK?offset=$ROOT_OFFSET" 2>/dev/null | python3 -c '
import importlib.machinery, importlib.util, sys
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader("slots", sys.argv[1])
spec = importlib.util.spec_from_loader("slots", loader)
slots = importlib.util.module_from_spec(spec)
loader.exec_module(slots)
try:
    env = slots.parse_env(sys.stdin.buffer.read())
except ValueError as err:
    # Mid-write or missing: report it as a value, so a scenario fails on it
    # rather than the whole run stopping.
    print(f"unreadable({err})")
else:
    print(" ".join(f"{key}={env[key]}" for key in slots.ENV_KEYS if env.get(key)))
' "$SLOTS"
}

mount_root() { mount -o "loop,offset=$ROOT_OFFSET" "$DISK" "$STAGE"; }
umount_root() { sync; umount "$STAGE"; }

# stage VERSION: give VERSION the one try, as `labkiosk-boot-slots try` does.
stage_try() {
    python3 -c '
import importlib.machinery, importlib.util, sys
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader("slots", sys.argv[1])
spec = importlib.util.spec_from_loader("slots", loader)
slots = importlib.util.module_from_spec(spec)
loader.exec_module(slots)
env = slots.read_env(sys.argv[2])
env.update(next=sys.argv[3], next_tries="1")
slots.write_env(sys.argv[2], env)
' "$SLOTS" "$STAGE/boot/grub" "$1"
}

# --------------------------------------------------------------------------
# The VM
# --------------------------------------------------------------------------
start_vm() {
    cp "$OVMF_VARS" "$WORK/vars.fd"
    rm -f "$WORK/qmp.sock"
    # -no-reboot: a reboot ends QEMU, which is how a rollback is observed.
    qemu-system-x86_64 \
        -machine q35,accel=kvm -cpu host -smp 2 -m 3072 \
        -drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE" \
        -drive if=pflash,format=raw,file="$WORK/vars.fd" \
        -drive file="$DISK",format=raw,if=virtio,file.locking=off \
        -nic user,model=virtio-net-pci \
        -vga std -display none -monitor none -serial none \
        -qmp unix:"$WORK/qmp.sock",server=on,wait=off \
        -no-reboot &
    VM_PID=$!
}

vm_running() { [ -n "$VM_PID" ] && kill -0 "$VM_PID" 2>/dev/null; }

stop_vm() {
    if vm_running; then
        kill "$VM_PID"
        # QEMU's exit status after SIGTERM carries nothing to check.
        wait "$VM_PID" 2>/dev/null || true
    fi
    VM_PID=""
}

# screenshot NAME: what the VM shows now, for a failed scenario.
screenshot() {
    python3 - "$WORK/qmp.sock" "$WORK/$1.ppm" <<'PY' || log "no screenshot: QMP did not answer"
import json, socket, sys
sock = socket.socket(socket.AF_UNIX)
sock.settimeout(10)
sock.connect(sys.argv[1])
stream = sock.makefile("rw")
json.loads(stream.readline())
for command in ({"execute": "qmp_capabilities"},
                {"execute": "screendump", "arguments": {"filename": sys.argv[2]}}):
    stream.write(json.dumps(command) + "\n")
    stream.flush()
    reply = json.loads(stream.readline())
    while "event" in reply:
        reply = json.loads(stream.readline())
    if "error" in reply:
        sys.exit(reply["error"]["desc"])
PY
}

# wait_for_exit SECONDS: 0 if QEMU exited (the guest rebooted) within SECONDS.
wait_for_exit() {
    local deadline=$((SECONDS + $1))
    while [ "$SECONDS" -lt "$deadline" ]; do
        vm_running || return 0
        sleep 5
    done
    return 1
}

expect_env() {  # expect_env SCENARIO "key=value ..."
    local got
    got="$(env_now)"
    if [ "$got" = "$2" ]; then
        pass "$1: grubenv $got"
    else
        fail "$1: grubenv '$got', expected '$2'"
    fi
}

# --------------------------------------------------------------------------
# Scenarios
# --------------------------------------------------------------------------
expect_env "install" "current=$VERSION"

log "1. promote: $V_GOOD gets one try and should become current"
mount_root
cp -a "$STAGE/images/$VERSION" "$STAGE/images/$V_GOOD"
stage_try "$V_GOOD"
umount_root
start_vm
promoted="current=$V_GOOD previous=$VERSION"
deadline=$((SECONDS + PROMOTE_TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ] && vm_running && [ "$(env_now)" != "$promoted" ]; do
    sleep 10
done
if [ "$(env_now)" = "$promoted" ]; then
    pass "promote: grubenv $promoted after $((PROMOTE_TIMEOUT - deadline + SECONDS)) s"
elif vm_running; then
    screenshot promote
    fail "promote: not promoted within $PROMOTE_TIMEOUT s; grubenv '$(env_now)'"
else
    fail "promote: the VM rebooted instead (health check failed?); grubenv '$(env_now)'"
fi
stop_vm

log "2. broken: $V_BROKEN has a damaged squashfs and should reboot back"
mount_root
cp -a "$STAGE/images/$VERSION" "$STAGE/images/$V_BROKEN"
truncate -s 1M "$STAGE/images/$V_BROKEN/filesystem.squashfs"
stage_try "$V_BROKEN"
umount_root
start_vm
if wait_for_exit "$BROKEN_TIMEOUT"; then
    expect_env "broken" "current=$V_GOOD previous=$VERSION next=$V_BROKEN next_tries=0"
else
    screenshot broken
    fail "broken: still running after $BROKEN_TIMEOUT s (stuck at an initramfs prompt?)"
    stop_vm
fi

log "3. recover: the next boot is $V_GOOD again and stays up"
start_vm
if wait_for_exit "$RECOVER_SECONDS"; then
    fail "recover: the VM rebooted within $RECOVER_SECONDS s"
else
    expect_env "recover" "current=$V_GOOD previous=$VERSION next=$V_BROKEN next_tries=0"
fi
stop_vm

log "4. unhealthy: $V_UNHEALTHY boots without its agent and should be rebooted away from"
mksquashfs "$ROOTFS" "$WORK/unhealthy.squashfs" -comp zstd -no-progress -quiet \
    -e opt/labkiosk/agent/agent.py >/dev/null
mount_root
mkdir "$STAGE/images/$V_UNHEALTHY"
cp "$STAGE/images/$VERSION/vmlinuz" "$STAGE/images/$VERSION/initrd.img" "$STAGE/images/$V_UNHEALTHY/"
cp "$WORK/unhealthy.squashfs" "$STAGE/images/$V_UNHEALTHY/filesystem.squashfs"
rm -rf "$STAGE/images/$V_BROKEN" "$WORK/unhealthy.squashfs"
stage_try "$V_UNHEALTHY"
umount_root
start_vm
started=$SECONDS
if wait_for_exit "$UNHEALTHY_TIMEOUT"; then
    elapsed=$((SECONDS - started))
    if [ "$elapsed" -lt "$UNHEALTHY_MIN" ]; then
        fail "unhealthy: rebooted after $elapsed s, before the health deadline could have passed"
    else
        expect_env "unhealthy (rebooted after $elapsed s)" \
            "current=$V_GOOD previous=$VERSION next=$V_UNHEALTHY next_tries=0"
    fi
else
    screenshot unhealthy
    fail "unhealthy: still running after $UNHEALTHY_TIMEOUT s"
    stop_vm
fi

if [ "$FAILED" -ne 0 ]; then
    log "Some scenarios failed; screenshots (if any) are in $WORK"
    exit 1
fi
log "All scenarios passed."
