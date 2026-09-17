# ==============================================================================
# Lab Kiosk ISO builder (ghcr.io/akbhoi/labkiosk-iso-builder)
#
# Usage (from the repository root):
#   docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder
#   docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" \
#       ghcr.io/akbhoi/labkiosk-iso-builder
#
# The engine must be ROOTFUL: debootstrap creates device nodes with mknod, which
# a rootless user namespace refuses even under --privileged.
#
# The source is COPYed in rather than bind-mounted, because Windows 9P/drvfs
# mounts enforce nodev/noexec and break mknod. The consequence is that this
# image must be REBUILT after any change under distro-builder/ -- running a
# stale image silently builds an ISO from the source baked into it.
# ==============================================================================
FROM debian:bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/akbhoi/labkiosk" \
      org.opencontainers.image.description="Debian 12 live-build environment that compiles the Lab Kiosk ISO." \
      org.opencontainers.image.licenses="BUSL-1.1"

ENV DEBIAN_FRONTEND=noninteractive

# Installed before the source is copied, so editing the kiosk config does not
# re-run apt on every rebuild.
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

# Name of the artifact written into /build/out; override with
# `docker run -e ISO_NAME=...` if a build needs a different filename.
ENV ISO_NAME=labkiosk-debian12-amd64.iso \
    OUT_DIR=/build/out

COPY --chmod=0755 docker-build.sh /usr/local/bin/docker-build.sh
COPY . /build/

CMD ["/usr/local/bin/docker-build.sh"]
