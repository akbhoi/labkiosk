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
FROM debian:trixie-slim

LABEL org.opencontainers.image.source="https://github.com/akbhoi/labkiosk" \
      org.opencontainers.image.description="Debian 13 live-build environment that compiles the Lab Kiosk ISO for the architecture it runs on." \
      org.opencontainers.image.licenses="SEE LICENSE IN LICENSE"

ENV DEBIAN_FRONTEND=noninteractive

# Asia/Kolkata (IST) everywhere, so container logs and anything the browser
# renders read in the same clock as the organization running it. tzdata is already in
# the base image; only the link and the name have to be set, and TZ covers the
# libraries that read the variable instead of /etc/localtime.
ENV TZ=Asia/Kolkata
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Installed before the source is copied, so editing the kiosk config does not
# re-run apt on every rebuild. The upgrade pulls in security fixes the base
# image does not carry yet, so a stale debian:trixie-slim never ships.
# The boot loader tools are the ones of the architecture this image runs on,
# which is the architecture it builds for (auto/config): GRUB for UEFI and
# legacy BIOS plus syslinux on amd64, GRUB for UEFI on arm64.
# CI passes the date here: a new value rebuilds the package layer below at
# least once a day, so a cached layer never keeps a package with a fixed CVE.
ARG APT_REFRESH=
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) bootloader_tools="grub-pc-bin grub-efi-amd64-bin isolinux syslinux-common" ;; \
         arm64) bootloader_tools="grub-efi-arm64-bin" ;; \
         *) echo "No boot loader tools are defined for $arch: see wiki/Building-for-Your-Platform.md" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
    live-build \
    debootstrap \
    squashfs-tools \
    xorriso \
    $bootloader_tools \
    mtools \
    dosfstools \
    ca-certificates \
    curl \
    librsvg2-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# The artifact is written into /build/out as labkiosk-debian13-<arch>.iso
# (docker-build.sh); `docker run -e ISO_NAME=...` names it otherwise.
ENV OUT_DIR=/build/out

COPY --chmod=0755 docker-build.sh /usr/local/bin/docker-build.sh
COPY . /build/

CMD ["/usr/local/bin/docker-build.sh"]
