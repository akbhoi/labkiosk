#!/usr/bin/env bash
# ==============================================================================
# Lab Kiosk OS - ISO Builder Script
# Builds a custom, ultra-lightweight, read-only Debian 12 Kiosk ISO
# ==============================================================================

set -e

# Ensure running as root
if [ "$EUID" -ne 0 ]; then
  echo "[!] Please run as root (sudo ./build-iso.sh)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================================="
echo "  Building Lab Kiosk OS (Debian 12 Bookworm)     "
echo "================================================="

# 1. Install prerequisites if missing
echo "[1/4] Checking build dependencies..."
apt-get update -qq
apt-get install -y -qq live-build debootstrap squashfs-tools xorriso grub-pc-bin grub-efi-amd64-bin mtools dosfstools isolinux syslinux-common

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
ISO_OUTPUT=$(ls -1 live-image-amd64.hybrid.iso 2>/dev/null || true)
if [ -n "$ISO_OUTPUT" ]; then
  mv "$ISO_OUTPUT" "labkiosk-debian12-amd64.iso"
  echo "================================================="
  echo "  SUCCESS! Kiosk ISO created:                    "
  echo "  -> $(pwd)/labkiosk-debian12-amd64.iso          "
  echo "================================================="
  echo "To test in QEMU:"
  echo "  qemu-system-x86_64 -m 2048 -cdrom labkiosk-debian12-amd64.iso -enable-kvm"
else
  echo "[!] Error: ISO file was not generated."
  exit 1
fi
