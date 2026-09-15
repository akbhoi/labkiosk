#!/bin/sh
# ==============================================================================
# In-container ISO build. This is the Dockerfile's CMD.
#
# It lives in a file rather than inline in the Dockerfile so that it is
# readable, diffable, and checked by shellcheck in CI -- the previous version
# was a single 300-character `CMD ["/bin/bash","-c", ...]` string in which a
# mistake was invisible until a ten-minute build failed.
# ==============================================================================
set -eu

ISO_NAME="${ISO_NAME:-labkiosk-debian12-amd64.iso}"
OUT_DIR="${OUT_DIR:-/build/out}"
# live-build's own output name, derived from LB_IMAGE_NAME in config/common.
LB_OUTPUT="live-image-amd64.hybrid.iso"

cd /build

mkdir -p "$OUT_DIR"

# Git does not preserve the executable bit on every platform (Windows checkouts
# in particular), and these are all executed by live-build.
chmod +x auto/* build-iso.sh 2>/dev/null || true
chmod +x config/hooks/live/*.hook.chroot 2>/dev/null || true
chmod +x config/includes.chroot/usr/local/bin/* 2>/dev/null || true

echo "[docker-build] Cleaning any previous build state..."
lb clean --purge

echo "[docker-build] Generating configuration from auto/config..."
lb config

echo "[docker-build] Building the live image (this takes several minutes)..."
lb build

if [ ! -f "$LB_OUTPUT" ]; then
    echo "[docker-build] ERROR: live-build reported success but $LB_OUTPUT is missing." >&2
    exit 1
fi

cp "$LB_OUTPUT" "$OUT_DIR/$ISO_NAME"

# Written from inside OUT_DIR so the checksum records a relative path and
# `sha256sum -c` works wherever the artifact is unpacked.
cd "$OUT_DIR"
sha256sum "$ISO_NAME" > "$ISO_NAME.sha256"

echo "[docker-build] Done:"
ls -lh "$OUT_DIR/$ISO_NAME" "$OUT_DIR/$ISO_NAME.sha256"
