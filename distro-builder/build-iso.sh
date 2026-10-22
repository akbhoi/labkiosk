#!/usr/bin/env bash
# ==============================================================================
# Lab Kiosk OS - ISO Builder Script
# Builds a custom, ultra-lightweight, read-only Debian 13 Kiosk ISO natively,
# for the architecture of this machine (amd64 or arm64). Run it on Debian 13:
# the live-build of an older release does not know trixie. Any other host
# builds with the container instead (distro-builder/Dockerfile).
# ==============================================================================

set -e

# Ensure running as root
if [ "$EUID" -ne 0 ]; then
  echo "[!] Please run as root (sudo ./build-iso.sh)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LABKIOSK_ARCH="${LABKIOSK_ARCH:-$(dpkg --print-architecture)}"
export LABKIOSK_ARCH
ISO_NAME="labkiosk-debian13-$LABKIOSK_ARCH.iso"

case "$LABKIOSK_ARCH" in
  amd64) BOOTLOADER_TOOLS="grub-pc-bin grub-efi-amd64-bin isolinux syslinux-common"; QEMU="qemu-system-x86_64 -m 2048 -enable-kvm -cdrom $ISO_NAME" ;;
  arm64) BOOTLOADER_TOOLS="grub-efi-arm64-bin"; QEMU="qemu-system-aarch64 -M virt -cpu host -enable-kvm -m 2048 -bios /usr/share/AAVMF/AAVMF_CODE.fd -device virtio-gpu-pci -device qemu-xhci -device usb-kbd -device usb-tablet -cdrom $ISO_NAME" ;;
  *) echo "[!] No build definition for $LABKIOSK_ARCH: see wiki/Building-for-Your-Platform.md"; exit 1 ;;
esac

codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
if [ "$codename" != "trixie" ]; then
  echo "[!] This host is '${codename:-unknown}', not Debian 13 (trixie). Its live-build may not"
  echo "    build trixie; if the build fails, use the container (distro-builder/README.md)."
fi

echo "================================================="
echo "  Building Lab Kiosk OS (Debian 13 trixie, $LABKIOSK_ARCH)"
echo "================================================="

# 1. Install prerequisites if missing
echo "[1/4] Checking build dependencies..."
apt-get update -qq
# shellcheck disable=SC2086 # one package name per word
apt-get install -y -qq live-build debootstrap squashfs-tools xorriso $BOOTLOADER_TOOLS mtools dosfstools librsvg2-bin

# 2. Clean previous build artifacts
echo "[2/4] Cleaning previous builds..."
lb clean --purge

# 3. Configure live-build
echo "[3/4] Initializing live-build configuration..."
lb config

# 4. Build the hybrid ISO
echo "[4/4] Generating hybrid ISO image (this may take a few minutes)..."
lb build

# Output check
ISO_OUTPUT=$(ls -1 "live-image-$LABKIOSK_ARCH.hybrid.iso" 2>/dev/null || true)
if [ -n "$ISO_OUTPUT" ]; then
  mv "$ISO_OUTPUT" "$ISO_NAME"
  sha256sum "$ISO_NAME" > "$ISO_NAME.sha256"
  echo "================================================="
  echo "  SUCCESS! Kiosk ISO created:"
  echo "  -> $(pwd)/$ISO_NAME"
  echo "================================================="
  echo "To test in QEMU:"
  echo "  $QEMU"
else
  echo "[!] Error: ISO file was not generated."
  exit 1
fi
