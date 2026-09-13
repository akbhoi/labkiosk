# Containerized Debian Kiosk Builder
# Usage:
#   docker build -t labkiosk-builder .
#   docker run --privileged -v $(pwd):/output labkiosk-builder
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
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . /build/

CMD ["/bin/bash", "-c", "lb clean --purge && lb config && lb build && cp live-image-amd64.hybrid.iso /output/labkiosk-debian12-amd64.iso"]
