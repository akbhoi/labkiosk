#!/bin/bash
# Smoke test of a live ISO of any architecture: boots the ISO's own kernel,
# initrd and system image in QEMU and passes once the kiosk is up -- the agent
# answers on 127.0.0.1:8888 and Chromium runs -- inside the guest.
#
# It is what arm64 has where amd64 has tests/vm/boot-test.sh: that test needs
# x86 firmware, legacy BIOS and an x86 Secure Boot chain throughout. This one
# proves the image itself (kernel, live-boot, the squashfs, systemd units, the
# kiosk session, X, the agent and the browser) but not the boot loader: QEMU
# loads the kernel directly, with the command line of the ISO's own first GRUB
# entry plus a serial console. The guest checks itself with systemd.run= and
# powers off; the marker it prints on the serial console is the verdict.
#
# Runs on a host of the ISO's architecture with KVM, or under emulation
# (TCG) without it, much slower: SMOKE_TIMEOUT (seconds, 1800 by default)
# bounds either.
#
# Needs: qemu-system-x86 or qemu-system-arm, xorriso.
#
# Usage: distro-builder/tests/vm/live-smoke-test.sh path/to/labkiosk-debian13-<arch>.iso [workdir]

set -euo pipefail

ISO="${1:?usage: $0 ISO [workdir]}"
WORK="${2:-$(mktemp -d /tmp/labkiosk-smoke.XXXXXX)}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-1800}"
MARKER="LABKIOSK-SMOKE-OK"

log() { printf '[smoke] %s\n' "$*"; }
die() { printf '[smoke] ERROR: %s\n' "$*" >&2; exit 2; }

[ -f "$ISO" ] || die "$ISO is not a file"
case "$SMOKE_TIMEOUT" in ''|*[!0-9]*) die "SMOKE_TIMEOUT must be a number of seconds" ;; esac
command -v xorriso >/dev/null || die "xorriso is not installed"
mkdir -p "$WORK"

case "$(basename "$ISO")" in
    *-amd64.iso)
        QEMU=qemu-system-x86_64
        MACHINE=(-machine q35)
        CONSOLE=ttyS0
        ;;
    *-arm64.iso)
        QEMU=qemu-system-aarch64
        MACHINE=(-machine virt)
        CONSOLE=ttyAMA0
        ;;
    *) die "cannot tell the architecture from the name $(basename "$ISO") (labkiosk-debian13-<arch>.iso)" ;;
esac
command -v "$QEMU" >/dev/null || die "$QEMU is not installed"

if [ -r /dev/kvm ] && [ -w /dev/kvm ] && [ "$(uname -m)" = "$( [ "$QEMU" = qemu-system-aarch64 ] && echo aarch64 || echo x86_64)" ]; then
    ACCEL=(-enable-kvm -cpu host)
    log "KVM"
else
    ACCEL=(-cpu max)
    log "No KVM for this architecture here: emulating (TCG), which is slow"
fi

log "Extracting the kernel, the initrd and the boot menu from $ISO"
if ! xorriso -osirrox on -indev "$ISO" \
    -extract /live/vmlinuz "$WORK/vmlinuz" \
    -extract /live/initrd.img "$WORK/initrd.img" \
    -extract /boot/grub/grub.cfg "$WORK/grub.cfg" >"$WORK/extract.log" 2>&1; then
    log "What the ISO holds in /live and /boot/grub:"
    xorriso -indev "$ISO" -lsl /live /boot/grub 2>/dev/null | sed 's/^/[smoke]   /' || true
    tail -n 20 "$WORK/extract.log" | sed 's/^/[smoke]   /'
    die "the ISO has no /live/vmlinuz, /live/initrd.img or /boot/grub/grub.cfg"
fi

# The first entry's command line, without the kernel's path: what the ISO
# boots by default.
read -r -a ENTRY < <(sed -n 's/^[[:space:]]*linux[[:space:]]\+//p' "$WORK/grub.cfg" | head -n 1)
[ "${#ENTRY[@]}" -gt 1 ] || die "the ISO's boot menu has no linux line"
# findiso=${iso_path} is for GRUB to fill in when it loops an ISO file; QEMU
# would pass it on literally and live-boot would look for that file.
words=()
for word in "${ENTRY[@]:1}"; do
    case "$word" in findiso=*) ;; *) words+=("$word") ;; esac
done
CMDLINE="${words[*]}"
case "$CMDLINE" in *boot=live*) ;; *) die "the first boot entry is not the live system: $CMDLINE" ;; esac

# Up when the agent answers and a Chromium process exists. No '$' or '%'
# anywhere: systemd expands both in a command line. The marker is printed in
# capitals from lower case, so the command line echoed on the console at boot
# never contains it.
CHECK="until curl -sf -o /dev/null http://127.0.0.1:8888/api/status && grep -qs chromium /proc/[0-9]*/comm; do sleep 3; done; echo ${MARKER,,} | tr a-z A-Z"
CMDLINE="$CMDLINE console=$CONSOLE,115200 systemd.journald.forward_to_console=1 systemd.run=\"/usr/bin/timeout $SMOKE_TIMEOUT /bin/sh -c '$CHECK'\" systemd.run_success_action=poweroff systemd.run_failure_action=poweroff"
log "Command line: $CMDLINE"

SERIAL="$WORK/serial.log"
: > "$SERIAL"
log "Booting; the serial console goes to $SERIAL"
status=0
timeout "$((SMOKE_TIMEOUT + 120))" "$QEMU" \
    "${MACHINE[@]}" "${ACCEL[@]}" -smp 2 -m 3072 \
    -kernel "$WORK/vmlinuz" -initrd "$WORK/initrd.img" -append "$CMDLINE" \
    -device virtio-scsi-pci,id=scsi -drive file="$ISO",if=none,id=cd,media=cdrom,readonly=on,format=raw \
    -device scsi-cd,drive=cd,bus=scsi.0 \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0,romfile= \
    -device virtio-gpu-pci -device qemu-xhci -device usb-kbd -device usb-tablet \
    -display none -monitor none -serial "file:$SERIAL" -no-reboot || status=$?

if grep -aq "$MARKER" "$SERIAL"; then
    log "PASS the kiosk came up: the agent answers and Chromium runs"
    exit 0
fi
log "FAIL the kiosk did not come up (QEMU exited with $status); the end of the serial console:"
grep -av "^$" "$SERIAL" | tail -n 80 | sed 's/^/[smoke]   /'
exit 1
