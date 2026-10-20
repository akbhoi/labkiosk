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
# Scenario 1 ends by switching the VM off, as a power cut would, so the boot
# after it (scenario 3; scenario 2 never reaches userspace) must find that and
# leave one restart report on the data partition, with the end of scenario 1's
# journal, which labkiosk-logs keeps there. Its journal must also show the
# encrypted swap partition in use behind compressed RAM, the kernel must say
# Secure Boot was enforced, and the hostname the installer stored must be set.
# After scenario 4, the journal of every boot must show the firewall loaded, X
# run by the kiosk user, the agent and x11vnc under their AppArmor profiles and
# the disk checked; what the profiles would still have blocked is printed.
#
# Then the signed download of phase 2. The kiosk has no shell, so the ISO's
# own labkiosk-update runs from the host on the disk's mounted image store,
# against a release signed with a key made for this run, served on loopback:
#
#   5. cut       the download is killed (SIGKILL) partway through the squashfs:
#                nothing reaches images/, and the disk still boots its image
#   6. tampered  a manifest changed after signing is refused; nothing changes
#   7. downgrade a validly signed release below the security floor is refused
#   8. resume    the download continues where it stopped and is verified
#   9. update    installed, the download gets its one try and becomes current
#
# Last, a second disk installed with an encrypted data partition, booted with a
# software TPM:
#
#  10. tpm       the first boot seals the key to the TPM and destroys the
#                one-time key; the second boot opens it without changing it;
#                with the TPM's state wiped the third boot recreates it, still
#                with nobody at the keyboard
#
# Then installing beside another system, and starting with no disk at all:
#
#  11. dual boot a disk that already holds another system (its EFI system
#                partition, its own partition, free space) gets Lab Kiosk in
#                the free space, with its own ESP: the other partitions and
#                the other system's ESP are untouched (a planted
#                EFI/debian/grub.cfg is never read), and the firmware entry
#                the installer registers starts Lab Kiosk, which promotes a try
#  12. pxe boot  UEFI PXE with Secure Boot on: shim, GRUB, kernel and initrd
#                over TFTP, the image over HTTP, from a boot server laid out
#                by tools/labkiosk-netboot.py; the workstation enrols by
#                itself and sends heartbeats with its token
#  13. ipxe boot the same from legacy BIOS through iPXE, under the same name
#
# UEFI HTTP Boot is not offered: Debian 12's signed GRUB starts over HTTP but
# has no HTTP client, so it stops at its prompt without its menu (seen here,
# GRUB 2.06-13+deb12u2; Debian bug #1016873).
#
# First of all, the image's phase 3 wiring, read from its root filesystem: the
# two update units, the updater they run, and the polkit rule that lets the
# kiosk user start them (and polkitd to apply it). The console flow that starts
# them needs a control plane and is tested end to end outside the VM.
#
# Scenario 5 kills the process, not the VM's power. What it proves is what a
# power cut leaves behind: an unfinished download is never booted, and the
# next run resumes it.
#
# The results are read from boot/grub/grubenv on the virtual disk, the same
# file GRUB and labkiosk-boot-slots use. A screenshot of the VM is saved for
# every scenario that fails.
#
# Needs root, /dev/kvm (GitHub's Linux runners have it) and:
#   qemu-system-x86 ovmf xorriso squashfs-tools e2fsprogs fdisk python3 gpg gpgv
#   swtpm cryptsetup-bin dosfstools python3-virt-firmware
#
# Usage: sudo distro-builder/tests/vm/boot-test.sh path/to/labkiosk-debian12-amd64.iso [workdir]
set -euo pipefail

ISO="${1:?usage: boot-test.sh LABKIOSK.iso [workdir]}"
WORK="${2:-$(dirname "$(readlink -f "$ISO")")/boot-test}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Secure Boot on, with Microsoft's keys enrolled, as on a PC from the shop:
# every boot below goes through the signed shim, GRUB and kernel, so a disk
# that only boots with Secure Boot off fails every scenario.
OVMF_CODE=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
OVMF_VARS=/usr/share/OVMF/OVMF_VARS_4M.ms.fd
# The installer refuses less than 7 GiB: room for two images.
DISK_SIZE=8G
# Generous margins over the agent's own numbers (60 s hold, 600 s deadline).
PROMOTE_TIMEOUT=900
BROKEN_TIMEOUT=300
RECOVER_SECONDS=240
UNHEALTHY_MIN=540
UNHEALTHY_TIMEOUT=1200

DISK="$WORK/disk.img"
TPM_DISK="$WORK/disk-tpm.img"
DUAL_DISK="$WORK/disk-dual.img"
NETROOT="$WORK/netboot"
ROOTFS="$WORK/rootfs"
LIVE="$WORK/live"
STAGE="$WORK/stage"
RELEASES="$WORK/releases"
VM_PID=""
LOOP=""
SERVER_PID=""
DOWNLOAD_PID=""
SWTPM_PID=""
NETBOOT_PID=""
FAILED=0

log() { printf '[boot-test] %s\n' "$*"; }
die() { printf '[boot-test] ERROR: %s\n' "$*" >&2; exit 2; }
fail() { printf '[boot-test] FAIL %s\n' "$*"; FAILED=1; }
pass() { printf '[boot-test] PASS %s\n' "$*"; }

cleanup() {
    stop_vm
    for pid in "$DOWNLOAD_PID" "$SERVER_PID" "$SWTPM_PID" "$NETBOOT_PID"; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid"
        fi
    done
    if [ -d "$WORK/gnupg" ]; then
        gpgconf --homedir "$WORK/gnupg" --kill gpg-agent
    fi
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
for tool in qemu-system-x86_64 xorriso unsquashfs mksquashfs debugfs sfdisk losetup python3 gpg gpgv gpgconf \
            swtpm cryptsetup mkfs.vfat virt-fw-vars; do
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
# The image's over-the-air wiring (phase 3)
# --------------------------------------------------------------------------
wiring_ok=1
for unit in labkiosk-update-download.service labkiosk-update-install.service; do
    if [ ! -f "$ROOTFS/etc/systemd/system/$unit" ]; then
        fail "wiring: the image has no $unit"; wiring_ok=0
    fi
    if ! grep -q "\"$unit\"" "$ROOTFS/etc/polkit-1/rules.d/50-labkiosk-update.rules" 2>/dev/null; then
        fail "wiring: the polkit rule does not let the kiosk user start $unit"; wiring_ok=0
    fi
done
if [ ! -x "$ROOTFS/usr/local/sbin/labkiosk-update" ]; then
    fail "wiring: /usr/local/sbin/labkiosk-update is not executable"; wiring_ok=0
fi
if [ ! -x "$ROOTFS/usr/lib/polkit-1/polkitd" ]; then
    fail "wiring: the image has no polkitd to apply its rules"; wiring_ok=0
fi
if [ "$wiring_ok" -eq 1 ]; then
    pass "wiring: update units, updater, polkit rule and polkitd are in the image"
fi

# --------------------------------------------------------------------------
# Install with the real installer, from inside the image
# --------------------------------------------------------------------------
# install_disk IMAGE [--encrypt-data] [--dual-boot]: a new virtual disk,
# installed; with --dual-boot, IMAGE already holds another system.
install_disk() {
    [ -e "$1" ] || truncate -s "$DISK_SIZE" "$1"
    LOOP="$(losetup -f --show -P "$1")"
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
    local status=0
    chroot "$ROOTFS" /usr/bin/python3 /tmp/install_into_disk.py "$LOOP" "${@:2}" || status=$?
    umount -R "$ROOTFS/run" "$ROOTFS/tmp" "$ROOTFS/sys" "$ROOTFS/proc" "$ROOTFS/dev"
    losetup -d "$LOOP"
    LOOP=""
    # The installer's own outcome, not the clean-up's.
    return "$status"
}

# partition_offset IMAGE NAME: the byte offset of the GPT partition NAME.
partition_offset() {
    sfdisk -J "$1" | python3 -c '
import json, sys
table = json.load(sys.stdin)["partitiontable"]
found = [p for p in table["partitions"] if p.get("name") == sys.argv[1]]
if len(found) != 1:
    sys.exit(f"expected one partition named {sys.argv[1]}")
print(found[0]["start"] * table.get("sectorsize", 512))
' "$2"
}

log "Installing onto a $DISK_SIZE virtual disk"
install_disk "$DISK"
ROOT_OFFSET="$(partition_offset "$DISK" ROOT)"
# DATA's offset, and the swap partition's GPT type (labkiosk-swap refuses any other).
DATA_OFFSET="$(sfdisk -J "$DISK" | python3 -c '
import json, sys
table = json.load(sys.stdin)["partitiontable"]
by_name = {p.get("name"): p for p in table["partitions"]}
if "DATA" not in by_name:
    sys.exit("expected a partition named DATA")
swap = by_name.get("SWAP")
if swap is None or swap["type"].upper() != "0657FD6D-A4AB-43C4-84E5-0933C84B4F4F":
    sys.exit(f"expected a Linux swap partition named SWAP, got {swap}")
print(by_name["DATA"]["start"] * table.get("sectorsize", 512))
')"
pass "install: SWAP is a Linux swap partition before DATA"

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
# start_vm [IMAGE [QEMU ARGS...]]: boot IMAGE ($DISK by default; "none" for
# no disk). VM_VARS replaces the firmware's starting variables (boot entries),
# VM_NIC the network card's options.
start_vm() {
    local disk="${1:-$DISK}"
    local drive=(-drive "file=$disk,format=raw,if=virtio,file.locking=off")
    [ "$disk" = none ] && drive=()
    cp "${VM_VARS:-$OVMF_VARS}" "$WORK/vars.fd"
    rm -f "$WORK/qmp.sock"
    # -no-reboot: a reboot ends QEMU, which is how a rollback is observed.
    qemu-system-x86_64 \
        -machine q35,smm=on,accel=kvm -cpu host -smp 2 -m 3072 \
        -global driver=cfi.pflash01,property=secure,value=on \
        -drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE" \
        -drive if=pflash,format=raw,file="$WORK/vars.fd" \
        "${drive[@]}" \
        -nic "${VM_NIC:-user,model=virtio-net-pci}" \
        -vga std -display none -monitor none -serial "${VM_SERIAL:-none}" \
        -qmp unix:"$WORK/qmp.sock",server=on,wait=off \
        -no-reboot "${@:2}" &
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

# serial_tail FILE: the end of a VM's serial console (the firmware and GRUB
# mirror their screen there), for a failed scenario.
serial_tail() {
    if [ -s "$1" ]; then
        log "last lines of $(basename "$1"):"
        sed -e 's/\x1b\[[0-9;?]*[A-Za-z]//g' -e 's/\r/\n/g' "$1" | tr -cd '\11\12\40-\176' \
            | grep -v '^[[:space:]]*$' | tail -n 40 | cut -c1-200
    else
        log "(nothing on the serial console)"
    fi
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
# What the screen shows halfway through the health window: kept only if the
# scenario fails, since a VM that rolls back reboots before it can be captured.
midway=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ] && vm_running && [ "$(env_now)" != "$promoted" ]; do
    if [ -n "$midway" ] && [ "$SECONDS" -ge "$midway" ]; then
        screenshot promote-midway
        midway=""
    fi
    sleep 10
done
if [ "$(env_now)" = "$promoted" ]; then
    rm -f "$WORK/promote-midway.ppm"
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

log "3b. restart: scenario 1's power-off is reported from the journal on DATA"
debugfs_data() { debugfs -R "$1" "$DISK?offset=$DATA_OFFSET" 2>/dev/null; }
mapfile -t reports < <(debugfs_data "ls /logs/reports" | grep -oE '[0-9a-f]{32}\.json' | sort -u)
if [ "${#reports[@]}" -ne 1 ]; then
    fail "restart: expected one restart report, found ${#reports[@]}: ${reports[*]:-none}"
elif debugfs_data "cat /logs/reports/${reports[0]}" | python3 "$HERE/check_restart_report.py" > "$WORK/report.txt" 2>&1; then
    pass "restart: $(cat "$WORK/report.txt")"
else
    fail "restart: ${reports[0]}: $(cat "$WORK/report.txt")"
fi
rm -rf "$WORK/journal"
mkdir "$WORK/journal"
debugfs_data "rdump /logs/journal $WORK/journal" >/dev/null
swap_lines="$(journalctl --directory="$WORK/journal/journal" --unit=labkiosk-swap.service --output=cat 2>/dev/null | grep 'In use:' || true)"
if printf '%s\n' "$swap_lines" | grep -q '/dev/zram0' && printf '%s\n' "$swap_lines" | grep -q '/dev/dm-'; then
    pass "swap: compressed RAM and the encrypted partition were in use"
else
    fail "swap: expected /dev/zram0 and an encrypted partition in labkiosk-swap's journal, got: ${swap_lines:-nothing}"
fi

if journalctl --directory="$WORK/journal/journal" --dmesg --output=cat 2>/dev/null | grep -q 'Secure boot enabled'; then
    pass "secure boot: the kernel ran with Secure Boot enforced"
else
    fail "secure boot: the kernel journal does not say 'Secure boot enabled'"
fi
stored_name="$(debugfs -R "cat /boot/grub/labkiosk-hostname.cfg" "$DISK?offset=$ROOT_OFFSET" 2>/dev/null | sed -n 's/^set kiosk_hostname="\([a-z0-9-]*\)"$/\1/p')"
if [ -n "$stored_name" ] && journalctl --directory="$WORK/journal/journal" --unit=labkiosk-hostname.service --output=cat 2>/dev/null | grep -qx "\[HOSTNAME\] Hostname: $stored_name"; then
    pass "hostname: $stored_name, as the installer stored it"
else
    fail "hostname: installer stored '${stored_name:-nothing}', labkiosk-hostname said: $(journalctl --directory="$WORK/journal/journal" --unit=labkiosk-hostname.service --output=cat 2>/dev/null | tail -n 3 | tr '\n' ' ')"
fi

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

log "4b. hardening: firewall, session, AppArmor and disk health, from the journal on DATA"
# Every boot so far is in it: scenario 4 ended in a clean reboot, which wrote
# out the journal.
rm -rf "$WORK/journal"
mkdir "$WORK/journal"
debugfs_data "rdump /logs/journal $WORK/journal" >/dev/null
journal() { journalctl --directory="$WORK/journal/journal" --output=cat "$@" 2>/dev/null || true; }
if journal --unit=nftables.service | grep -q '^Finished nftables'; then
    pass "firewall: nftables.service loaded the ruleset"
else
    fail "firewall: nftables.service did not finish: $(journal --unit=nftables.service | tail -n 3 | tr '\n' ' ')"
fi
health_lines="$(journal --unit=labkiosk-health.service | grep '^\[HEALTH\]' || true)"
if printf '%s\n' "$health_lines" | grep -qx '\[HEALTH\] Display server: Xorg runs as kiosk\.'; then
    pass "session: Xorg ran as the kiosk user, not root"
else
    fail "session: expected Xorg to run as kiosk, labkiosk-health said: $(printf '%s\n' "$health_lines" | grep 'Display server' | sort -u | tr '\n' ' ')"
fi
if printf '%s\n' "$health_lines" | grep -q '^\[HEALTH\] AppArmor: agent labkiosk-agent (complain); x11vnc labkiosk-x11vnc (complain)\.$'; then
    pass "apparmor: the agent and x11vnc ran under their profiles, in complain mode"
else
    fail "apparmor: expected both profiles attached, labkiosk-health said: $(printf '%s\n' "$health_lines" | grep 'AppArmor' | sort -u | tr '\n' ' ')"
    log "apparmor: what labkiosk-apparmor.service and the kernel said:"
    journal --unit=labkiosk-apparmor.service | tail -n 40
    journalctl --directory="$WORK/journal/journal" --output=cat _TRANSPORT=kernel 2>/dev/null \
        | grep -i 'apparmor' | sort | uniq -c | head -n 40 || true
fi
if printf '%s\n' "$health_lines" | grep -q '^\[HEALTH\] Disk vda '; then
    pass "disk health: $(printf '%s\n' "$health_lines" | grep '^\[HEALTH\] Disk vda ' | tail -n 1)"
else
    fail "disk health: labkiosk-health checked no disk: $(printf '%s\n' "$health_lines" | tail -n 3 | tr '\n' ' ')"
fi
# Complain mode blocks nothing; what it would have blocked is what the profiles
# still lack. Listed for whoever tightens them, never a failure.
complaints="$(journalctl --directory="$WORK/journal/journal" --output=cat _TRANSPORT=kernel _TRANSPORT=audit 2>/dev/null \
    | grep -E 'apparmor="(ALLOWED|DENIED)".*profile="labkiosk-' \
    | while read -r line; do
        printf '%s\n' "$line" | grep -oE '(operation|profile|name|requested_mask)="[^"]*"' | tr '\n' ' '
        echo
    done | sort | uniq -c | sort -rn || true)"
if [ -n "$complaints" ]; then
    log "apparmor: what the profiles do not cover yet (complain mode, nothing was blocked):"
    # Not a pipe: head closing it early kills printf with SIGPIPE, which
    # pipefail turns into a failed boot test.
    head -n 60 <<< "$complaints"
else
    log "apparmor: no complaints from either profile"
fi
# A failed health check says which half of it failed, and the session's own
# output (X, Openbox, the browser) says why; both are on DATA.
if [ "$FAILED" -ne 0 ]; then
    log "boot-ok: what labkiosk-boot-slots said on every boot so far:"
    journal --unit=labkiosk-boot-ok.service | tail -n 40
    log "session: the end of labkiosk-session's output:"
    journal --unit=labkiosk-session.service | tail -n 80
    # pam_systemd moves the session's processes into a session scope, so what
    # X, Openbox and the browser print is found by the kiosk user's uid.
    log "session: what the kiosk user's processes printed:"
    journalctl --directory="$WORK/journal/journal" --output=short-monotonic \
        _UID="$(awk -F: '$1 == "kiosk" { print $3 }' "$ROOTFS/etc/passwd")" 2>/dev/null | tail -n 200 || true
fi

# --------------------------------------------------------------------------
# Phase 2: a signed release, downloaded by the image's own labkiosk-update
# --------------------------------------------------------------------------
UPDATE="$ROOTFS/usr/local/sbin/labkiosk-update"
FLOOR="$(tr -d '[:space:]' < "$ROOTFS/usr/share/labkiosk/security-floor")"
IFS=. read -r major minor patch <<< "$BASE"
V_OTA="$major.$minor.$((patch + 1))"
V_OLD="0.0.1"
KEYS="$WORK/update-keys"
log "Release $V_OTA signed with a key made for this run; security floor $FLOOR"

export GNUPGHOME="$WORK/gnupg"
mkdir -m 0700 "$GNUPGHOME"
mkdir "$KEYS"
gpg --batch --pinentry-mode loopback --passphrase '' \
    --quick-gen-key "Lab Kiosk boot test <boot-test@example.invalid>" ed25519 sign never 2>/dev/null
gpg --batch --export > "$KEYS/current.gpg"

# publish VERSION FLOOR: a signed release folder under $RELEASES. The image
# files are hard links: the version lives in the signed manifest, as on R2.
publish() {
    mkdir -p "$RELEASES/$1"
    for name in vmlinuz initrd.img filesystem.squashfs; do
        ln "$LIVE/$name" "$RELEASES/$1/$name"
    done
    python3 "$HERE/../../tools/make-release-manifest.py" --live "$RELEASES/$1" --version "$1" \
        --security-floor "$2" --channel stable --out "$RELEASES/$1/manifest.json"
    gpg --batch --yes --detach-sign --output "$RELEASES/$1/manifest.json.sig" "$RELEASES/$1/manifest.json"
}
publish "$V_OTA" "$FLOOR"
publish "$V_OLD" "$V_OLD"
mkdir "$RELEASES/tampered"
cp "$RELEASES/$V_OTA/manifest.json.sig" "$RELEASES/tampered/"
sed 's/"stable"/"beta"/' "$RELEASES/$V_OTA/manifest.json" > "$RELEASES/tampered/manifest.json"
if cmp -s "$RELEASES/$V_OTA/manifest.json" "$RELEASES/tampered/manifest.json"; then
    die "the tampered manifest is no different from the signed one"
fi

# 50 MB/s: the whole release in well under a minute, slow enough to be cut.
python3 "$HERE/release_server.py" "$RELEASES" --rate 50000000 > "$WORK/server.port" &
SERVER_PID=$!
for _ in $(seq 50); do
    [ -s "$WORK/server.port" ] && break
    sleep 0.2
done
[ -s "$WORK/server.port" ] || die "the release server did not start"
URL="http://127.0.0.1:$(cat "$WORK/server.port")"

# update COMMAND TARGET: labkiosk-update on the mounted image store, as the
# disk's current image would run it.
update() {
    python3 "$HERE/update_on_disk.py" "$UPDATE" "$1" "$STAGE" "$2" "$V_GOOD" "$FLOOR" "$KEYS"
}

# Every path, size and time in the image store: a refusal changes none of them.
store_listing() { (cd "$STAGE" && find . -printf '%p %s %T@\n' | sort); }

log "5. cut: the download of $V_OTA is killed partway through"
mount_root
# Started directly, not through update(), so that the PID is python's own.
python3 "$HERE/update_on_disk.py" "$UPDATE" download "$STAGE" "$URL/$V_OTA" "$V_GOOD" "$FLOOR" "$KEYS" \
    > "$WORK/download.json" &
DOWNLOAD_PID=$!
partial="$STAGE/downloads/$V_OTA/filesystem.squashfs"
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ] && kill -0 "$DOWNLOAD_PID" 2>/dev/null; do
    if [ "$(stat -c %s "$partial" 2>/dev/null || echo 0)" -ge $((64 * 1024 * 1024)) ]; then
        break
    fi
    sleep 0.2
done
if kill -9 "$DOWNLOAD_PID" 2>/dev/null; then
    # A SIGKILLed process exits 137 by definition; there is nothing to check.
    wait "$DOWNLOAD_PID" 2>/dev/null || true
    DOWNLOAD_PID=""
    if [ -e "$STAGE/images/$V_OTA" ]; then
        fail "cut: images/$V_OTA exists after the download was killed"
    else
        pass "cut: killed with $(stat -c %s "$partial") bytes of the squashfs on disk, outside images/"
    fi
else
    wait "$DOWNLOAD_PID" 2>/dev/null || true
    DOWNLOAD_PID=""
    fail "cut: the download ended before it could be killed: $(cat "$WORK/download.json")"
fi
umount_root
# The download made room: the rollback image and the failed try are gone.
expect_env "cut" "current=$V_GOOD"
start_vm
if wait_for_exit "$RECOVER_SECONDS"; then
    fail "cut: the VM rebooted within $RECOVER_SECONDS s"
else
    expect_env "cut (booted)" "current=$V_GOOD"
fi
stop_vm

# refused NUMBER NAME TARGET REASON: a release labkiosk-update must turn down
# before it writes anything.
refused() {
    log "$1. $2: $3 must be refused"
    mount_root
    local before
    before="$(store_listing)"
    if update download "$3" > "$WORK/$2.json"; then
        fail "$2: accepted: $(cat "$WORK/$2.json")"
    elif ! grep -qF "$4" "$WORK/$2.json"; then
        fail "$2: refused for another reason: $(cat "$WORK/$2.json")"
    elif [ "$(store_listing)" != "$before" ]; then
        fail "$2: refused, but the image store changed"
    else
        pass "$2: refused ($4), nothing written"
    fi
    umount_root
}
refused 6 tampered "$URL/tampered" "signature does not verify"
refused 7 downgrade "$URL/$V_OLD" "below this workstation's security floor"

log "8. resume: the download of $V_OTA continues and is verified"
mount_root
if update download "$URL/$V_OTA" > "$WORK/download.json"; then
    if [ -f "$STAGE/images/$V_OTA/.verified" ] && [ ! -e "$STAGE/downloads/$V_OTA" ]; then
        pass "resume: $(cat "$WORK/download.json")"
    else
        fail "resume: reported success, but images/$V_OTA is not a verified download"
    fi
else
    fail "resume: $(cat "$WORK/download.json")"
fi

log "9. update: $V_OTA is installed, gets its one try and becomes current"
if update install "$V_OTA" > "$WORK/install.json"; then
    pass "update: $(cat "$WORK/install.json")"
else
    fail "update: install refused: $(cat "$WORK/install.json")"
fi
umount_root
expect_env "update (staged)" "current=$V_GOOD next=$V_OTA next_tries=1"
start_vm
promoted="current=$V_OTA previous=$V_GOOD"
deadline=$((SECONDS + PROMOTE_TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ] && vm_running && [ "$(env_now)" != "$promoted" ]; do
    sleep 10
done
if [ "$(env_now)" = "$promoted" ]; then
    pass "update: grubenv $promoted"
elif vm_running; then
    screenshot update
    fail "update: not promoted within $PROMOTE_TIMEOUT s; grubenv '$(env_now)'"
else
    fail "update: the VM rebooted instead (health check failed?); grubenv '$(env_now)'"
fi
stop_vm

# --------------------------------------------------------------------------
# An encrypted data partition, unlocked by a TPM
# --------------------------------------------------------------------------
log "10. tpm: a disk with an encrypted data partition, booted with a software TPM"
install_disk "$TPM_DISK" --encrypt-data
TPM_ROOT_OFFSET="$(partition_offset "$TPM_DISK" ROOT)"
# The console on the serial port, so labkiosk-data-unlock's own account of
# each boot is readable here: its journal is on the volume under test.
mount -o "loop,offset=$TPM_ROOT_OFFSET" "$TPM_DISK" "$STAGE"
sed -i 's/ noeject panic=10$/ noeject panic=10 console=tty0 console=ttyS0,115200/' "$STAGE/boot/grub/grub.cfg"
grep -q 'console=ttyS0' "$STAGE/boot/grub/grub.cfg" || die "could not add the serial console to the TPM disk's boot menu"
umount_root
TPM_STATE="$WORK/tpm-state"
mkdir -m 0700 "$TPM_STATE"

# luks_header: the data partition's LUKS header (key slots, tokens, salts),
# which changes if the partition is recreated.
luks_header() {
    local loop
    loop="$(losetup -f --show -P -r "$TPM_DISK")"
    cryptsetup luksDump "${loop}p4"
    losetup -d "$loop"
}
# sealed_to_tpm: reads a header on stdin; true when it has exactly one key
# slot and a systemd-tpm2 token that uses that slot (and nothing opens it but
# the TPM).
sealed_to_tpm() {
    python3 -c '
import re, sys
dump = sys.stdin.read()
keyslots = dump.partition("\nKeyslots:")[2].partition("\nTokens:")[0]
tokens = dump.partition("\nTokens:")[2].partition("\nDigests:")[0]
slots = set(re.findall(r"(?m)^  (\d+): luks2$", keyslots))
token_slots = set()
for token in re.split(r"(?m)^  (?=\d+: )", tokens)[1:]:
    if token.split("\n", 1)[0].split(": ", 1)[1].strip() == "systemd-tpm2":
        token_slots |= set(re.findall(r"(?m)^\s+Keyslot:\s+(\d+)$", token))
print(f"key slots {sorted(slots)}, TPM token slots {sorted(token_slots)}", file=sys.stderr)
sys.exit(0 if len(slots) == 1 and slots == token_slots else 1)
'
}
first_boot_key_present() {
    debugfs -R "stat /boot/grub/labkiosk-data.key" "$TPM_DISK?offset=$TPM_ROOT_OFFSET" 2>/dev/null | grep -q '^Inode:'
}
# tpm_boot NAME: boot the encrypted disk with the TPM in $TPM_STATE, and leave
# it running long enough to unlock (or recreate) the partition and settle.
tpm_boot() {
    rm -f "$WORK/swtpm.sock"
    swtpm socket --tpm2 --tpmstate dir="$TPM_STATE" --ctrl type=unixio,path="$WORK/swtpm.sock" &
    SWTPM_PID=$!
    for _ in $(seq 50); do
        [ -S "$WORK/swtpm.sock" ] && break
        sleep 0.2
    done
    VM_SERIAL="file:$WORK/tpm-serial-${1// /-}.log" start_vm "$TPM_DISK" -chardev socket,id=chrtpm,path="$WORK/swtpm.sock" \
        -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0
    if wait_for_exit "$RECOVER_SECONDS"; then
        fail "tpm: $1: the VM rebooted within $RECOVER_SECONDS s"
    fi
    stop_vm
    if kill -0 "$SWTPM_PID" 2>/dev/null; then
        kill "$SWTPM_PID"
    fi
    wait "$SWTPM_PID" 2>/dev/null || true
    SWTPM_PID=""
    log "tpm: $1: labkiosk-data-unlock said:"
    grep -a '\[DATA\]' "$WORK/tpm-serial-${1// /-}.log" | cut -c1-6000 || log "(nothing on the serial console)"
}

if ! first_boot_key_present; then
    fail "tpm: the installer left no one-time key in boot/grub"
fi
installed_header="$(luks_header)"
tpm_boot "first boot"
sealed_header="$(luks_header)"
if first_boot_key_present; then
    fail "tpm: the one-time key is still in boot/grub after the first boot"
elif ! printf '%s\n' "$sealed_header" | sealed_to_tpm; then
    fail "tpm: after the first boot the only key slot is not the TPM token's"
elif [ "$sealed_header" = "$installed_header" ]; then
    fail "tpm: the header did not change on the first boot"
else
    pass "tpm: first boot sealed the key to the TPM and destroyed the one-time key"
fi

tpm_boot "second boot"
if [ "$(luks_header)" = "$sealed_header" ]; then
    pass "tpm: second boot opened the data partition with the TPM, unchanged"
else
    fail "tpm: the header changed on the second boot (recreated instead of unlocked?)"
fi

rm -rf "$TPM_STATE"
mkdir -m 0700 "$TPM_STATE"
tpm_boot "TPM wiped"
reset_header="$(luks_header)"
if [ "$reset_header" = "$sealed_header" ]; then
    fail "tpm: with the TPM wiped the data partition was not recreated"
elif ! printf '%s\n' "$reset_header" | sealed_to_tpm; then
    fail "tpm: the recreated partition's only key slot is not the new TPM token's"
else
    pass "tpm: with the TPM wiped the data partition was recreated and sealed again"
fi

# --------------------------------------------------------------------------
# 11. Dual boot: beside another system on a shared drive
# --------------------------------------------------------------------------
log "11. dual boot: a drive with another system gets Lab Kiosk in its free space"
OTHER_MARKER="the other system's files"
truncate -s 12G "$DUAL_DISK"
printf '%s\n' 'label: gpt' \
    'size=100MiB, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name="EFI system partition"' \
    'size=2GiB, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="other"' | sfdisk --quiet "$DUAL_DISK"
LOOP="$(losetup -f --show -P "$DUAL_DISK")"
mkfs.vfat -F 32 -n OTHERESP "${LOOP}p1" >/dev/null
mkfs.ext4 -q -L OTHER "${LOOP}p2"
mount "${LOOP}p1" "$STAGE"
mkdir -p "$STAGE/EFI/BOOT" "$STAGE/EFI/debian"
printf 'the other system boot loader\n' > "$STAGE/EFI/BOOT/BOOTX64.EFI"
# Where Debian's signed GRUB looks first for its menu (its built-in prefix):
# if Lab Kiosk's GRUB read this instead of its own, the VM would halt.
printf '%s\n' 'echo "decoy: the other system menu was read"' 'sleep 10' 'halt' > "$STAGE/EFI/debian/grub.cfg"
(cd "$STAGE" && find EFI -type f -exec sha256sum {} +) | sort > "$WORK/esp-before.txt"
umount "$STAGE"
mount "${LOOP}p2" "$STAGE"
printf '%s\n' "$OTHER_MARKER" > "$STAGE/marker"
umount "$STAGE"
losetup -d "$LOOP"
LOOP=""
sfdisk -J "$DUAL_DISK" > "$WORK/dual-before.json"

if install_disk "$DUAL_DISK" --dual-boot; then
    pass "dual boot: installed beside the other system, its firmware entry first in the boot order"
else
    fail "dual boot: the installer failed"
fi
sfdisk -J "$DUAL_DISK" > "$WORK/dual-after.json"
if python3 "$HERE/check_dual_boot_layout.py" "$WORK/dual-before.json" "$WORK/dual-after.json"; then
    pass "dual boot: the other system's partitions are unchanged; Lab Kiosk's ESP, ROOT, DATA and SWAP were added"
else
    fail "dual boot: the partition table is not as expected"
fi
other_offset="$(partition_offset "$DUAL_DISK" other)"
if [ "$(debugfs -R "cat /marker" "$DUAL_DISK?offset=$other_offset" 2>/dev/null)" = "$OTHER_MARKER" ]; then
    pass "dual boot: the other system's files are intact"
else
    fail "dual boot: the other system's partition lost its files"
fi
esp_offset="$(partition_offset "$DUAL_DISK" "EFI system partition")"
mount -o "ro,loop,offset=$esp_offset" "$DUAL_DISK" "$STAGE"
(cd "$STAGE" && find EFI -type f -exec sha256sum {} +) | sort > "$WORK/esp-after.txt"
umount "$STAGE"
own_esp_offset="$(partition_offset "$DUAL_DISK" LABKIOSK_ESP)"
mount -o "ro,loop,offset=$own_esp_offset" "$DUAL_DISK" "$STAGE"
labkiosk_loader=0
if [ -f "$STAGE/EFI/LabKiosk/shimx64.efi" ] && [ -f "$STAGE/EFI/LabKiosk/grubx64.efi" ]; then
    labkiosk_loader=1
fi
umount "$STAGE"
if ! cmp -s "$WORK/esp-before.txt" "$WORK/esp-after.txt"; then
    fail "dual boot: the other system's ESP changed: $(diff "$WORK/esp-before.txt" "$WORK/esp-after.txt" | tr '\n' ' ')"
elif [ "$labkiosk_loader" -ne 1 ]; then
    fail "dual boot: Lab Kiosk's own ESP has no EFI/LabKiosk shim and GRUB"
else
    pass "dual boot: the other system's ESP is untouched; Lab Kiosk's loader is on its own ESP"
fi

# The firmware entry the installer registered (the stand-in checked its
# arguments), first in the boot order as on the real machine.
virt-fw-vars --input "$OVMF_VARS" --output "$WORK/vars-dual.fd" \
    --append-boot-filepath '\EFI\LabKiosk\shimx64.efi' >/dev/null 2>&1
SAVED_DISK="$DISK"
SAVED_ROOT_OFFSET="$ROOT_OFFSET"
DISK="$DUAL_DISK"
ROOT_OFFSET="$(partition_offset "$DUAL_DISK" LABKIOSK_ROOT)"
expect_env "dual boot: install" "current=$VERSION"
mount_root
cp -a "$STAGE/images/$VERSION" "$STAGE/images/$V_GOOD"
stage_try "$V_GOOD"
umount_root
VM_SERIAL="file:$WORK/dual-boot-serial.log" VM_VARS="$WORK/vars-dual.fd" start_vm
promoted="current=$V_GOOD previous=$VERSION"
deadline=$((SECONDS + PROMOTE_TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ] && vm_running && [ "$(env_now)" != "$promoted" ]; do
    sleep 10
done
if [ "$(env_now)" = "$promoted" ]; then
    pass "dual boot: started from its firmware entry and promoted $V_GOOD"
elif vm_running; then
    screenshot dual-boot
    fail "dual boot: not promoted within $PROMOTE_TIMEOUT s; grubenv '$(env_now)'"
    serial_tail "$WORK/dual-boot-serial.log"
else
    fail "dual boot: the VM stopped (the other system's menu, or a failed boot); grubenv '$(env_now)'"
    serial_tail "$WORK/dual-boot-serial.log"
fi
stop_vm
DISK="$SAVED_DISK"
ROOT_OFFSET="$SAVED_ROOT_OFFSET"

# --------------------------------------------------------------------------
# 12-14. Network boot: no disk, everything from a boot server on the LAN
# --------------------------------------------------------------------------
NETBOOT_ORG="netboot-test"
# A valid key: its last character checks the rest (ENROLLMENT_KEY_VECTORS).
NETBOOT_KEY="AAAAA-AAAAA-AAAAA-AAAAA"
NETBOOT_EVENTS="$WORK/netboot-events.jsonl"
NETBOOT_TIMEOUT=900
NETBOOT_CLIENTS=()
log "Laying out the boot server with tools/labkiosk-netboot.py"
if python3 "$HERE/../../tools/labkiosk-netboot.py" prepare --live-dir "$LIVE" --out "$NETROOT" \
        --server-address 10.0.2.2 --org "$NETBOOT_ORG" --key "$NETBOOT_KEY" \
        --control-plane http://10.0.2.2; then
    pass "netboot: the boot server's folder was laid out"
else
    fail "netboot: labkiosk-netboot.py prepare failed"
fi
: > "$NETBOOT_EVENTS"
python3 "$HERE/netboot_server.py" "$NETROOT" "$NETBOOT_EVENTS" "$NETBOOT_ORG" "$NETBOOT_KEY" \
    2> "$WORK/netboot-server.log" &
NETBOOT_PID=$!
sleep 1
kill -0 "$NETBOOT_PID" 2>/dev/null || die "the boot server did not start: $(cat "$WORK/netboot-server.log")"

# netboot_heartbeat: print the client id that sent a heartbeat with the token
# it was enrolled with, among events after those seen so far.
netboot_heartbeat() {
    local seen deadline
    seen="$(wc -l < "$NETBOOT_EVENTS")"
    deadline=$((SECONDS + NETBOOT_TIMEOUT))
    while [ "$SECONDS" -lt "$deadline" ] && vm_running; do
        if tail -n "+$((seen + 1))" "$NETBOOT_EVENTS" | python3 "$HERE/check_netboot_events.py"; then
            return 0
        fi
        sleep 5
    done
    return 1
}

# netboot_scenario NAME: once the VM is started, with its serial console in
# $WORK/<NAME>-serial.log; NETBOOT_LOG_FROM is where the boot server's log
# stood when it started.
netboot_scenario() {
    local client
    if client="$(netboot_heartbeat)"; then
        if [[ "$client" =~ ^LABKIOSK-[0-9A-F]{6}$ ]]; then
            pass "$1: enrolled by itself as $client and sent heartbeats with its token"
        else
            fail "$1: enrolled under an unexpected name '$client'"
        fi
        NETBOOT_CLIENTS+=("$client")
    else
        screenshot "${1// /-}"
        fail "$1: no heartbeat within $NETBOOT_TIMEOUT s"
        log "what the boot server was asked for:"
        tail -n "+$((NETBOOT_LOG_FROM + 1))" "$WORK/netboot-server.log" | cut -c1-200 | tail -n 40
        serial_tail "$WORK/${1// /-}-serial.log"
    fi
    stop_vm
}

log "12. pxe boot: UEFI PXE with Secure Boot on, shim and GRUB over TFTP"
NETBOOT_LOG_FROM="$(wc -l < "$WORK/netboot-server.log")"
VM_SERIAL="file:$WORK/pxe-boot-serial.log" \
    VM_NIC="user,model=virtio-net-pci,tftp=$NETROOT,bootfile=labkiosk/shimx64.efi" start_vm none
netboot_scenario "pxe boot"

log "13. ipxe boot: legacy BIOS through iPXE"
NETBOOT_LOG_FROM="$(wc -l < "$WORK/netboot-server.log")"
rm -f "$WORK/qmp.sock"
qemu-system-x86_64 \
    -machine q35,accel=kvm -cpu host -smp 2 -m 3072 \
    -nic user,model=virtio-net-pci,bootfile=http://10.0.2.2/labkiosk/boot.ipxe -boot n \
    -vga std -display none -monitor none -serial file:"$WORK/ipxe-boot-serial.log" \
    -qmp unix:"$WORK/qmp.sock",server=on,wait=off \
    -no-reboot &
VM_PID=$!
netboot_scenario "ipxe boot"

if [ "${#NETBOOT_CLIENTS[@]}" -ge 2 ]; then
    if [ "$(printf '%s\n' "${NETBOOT_CLIENTS[@]}" | sort -u | wc -l)" -eq 1 ]; then
        pass "netboot: every boot of the same machine enrolled under one name, ${NETBOOT_CLIENTS[0]}"
    else
        fail "netboot: the same machine enrolled under different names: ${NETBOOT_CLIENTS[*]}"
    fi
fi
kill "$NETBOOT_PID"
wait "$NETBOOT_PID" 2>/dev/null || true
NETBOOT_PID=""

if [ "$FAILED" -ne 0 ]; then
    log "Some scenarios failed; screenshots (if any) are in $WORK"
    exit 1
fi
log "All scenarios passed."
