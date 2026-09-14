# Containerized Debian Kiosk Builder
# Usage (from the repository root):
#   docker build -t labkiosk-iso-builder distro-builder
#   docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" labkiosk-iso-builder
#
# The ISO is written to /build/out inside the container, which is the path the
# distro-builder/README.md and the release workflow both mount.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    live-build \
    debootstrap \
    squashfs-tools \
    xorriso \
    grub-pc-bin \
    grub-efi-amd64-bin \
    mtools \
    dosfstools \
    isolinux \
    syslinux-common \
    ca-certificates \
    curl \
    librsvg2-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . /build/

RUN chmod +x /build/auto/* /build/build-iso.sh /build/config/hooks/live/*.hook.chroot /build/config/includes.chroot/usr/local/bin/* 2>/dev/null || true

CMD ["/bin/bash", "-c", "set -e; mkdir -p /build/out; chmod +x auto/* build-iso.sh config/hooks/live/*.hook.chroot config/includes.chroot/usr/local/bin/* 2>/dev/null || true; lb clean --purge; lb config; lb build; cp live-image-amd64.hybrid.iso /build/out/labkiosk-debian12-amd64.iso; sha256sum /build/out/labkiosk-debian12-amd64.iso > /build/out/labkiosk-debian12-amd64.iso.sha256"]
