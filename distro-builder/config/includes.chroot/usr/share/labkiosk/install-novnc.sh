#!/bin/sh
# Install the noVNC web client from the release pinned in novnc.pin.
#
# Used by 01-lockdown.hook.chroot (ISO) and by the simulator Dockerfile, so both
# ship byte-identical client files. Fails closed: no pin, a download error or a
# checksum mismatch aborts, because remote control is useless without it.
#
# Usage: install-novnc.sh [PIN_FILE] [DEST_DIR]
set -eu

PIN="${1:-/usr/share/labkiosk/novnc.pin}"
DEST="${2:-/usr/share/novnc}"

VERSION="$(sed -n 's/^VERSION=//p' "$PIN" | tr -d '[:space:]')"
SHA256="$(sed -n 's/^SHA256=//p' "$PIN" | tr -d '[:space:]')"

if [ -z "$VERSION" ] || [ -z "$SHA256" ]; then
    echo "[novnc] ERROR: $PIN must set both VERSION and SHA256." >&2
    exit 1
fi
case "$VERSION" in
    *[!0-9.]*)
        echo "[novnc] ERROR: unexpected VERSION '$VERSION' in $PIN." >&2
        exit 1
        ;;
esac

URL="https://github.com/novnc/noVNC/archive/refs/tags/v${VERSION}.tar.gz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "[novnc] Downloading noVNC ${VERSION}..."
if ! curl -fsSL --retry 3 "$URL" -o "$WORK/novnc.tar.gz"; then
    echo "[novnc] ERROR: could not download $URL" >&2
    exit 1
fi

ACTUAL="$(sha256sum "$WORK/novnc.tar.gz" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$SHA256" ]; then
    echo "[novnc] ERROR: checksum mismatch for noVNC ${VERSION}." >&2
    echo "[novnc]   expected: $SHA256" >&2
    echo "[novnc]   actual:   $ACTUAL" >&2
    exit 1
fi

mkdir -p "$WORK/src"
tar -xzf "$WORK/novnc.tar.gz" -C "$WORK/src" --strip-components=1

# Only what the browser loads; tests, docs, translations sources and packaging
# stay out. The optional JSON files are app settings read by vnc.html.
rm -rf "$DEST"
mkdir -p "$DEST"
for item in app core vendor vnc.html vnc_lite.html LICENSE.txt; do
    if [ ! -e "$WORK/src/$item" ]; then
        echo "[novnc] ERROR: noVNC ${VERSION} has no $item; the layout changed." >&2
        exit 1
    fi
    cp -R "$WORK/src/$item" "$DEST/"
done
for item in defaults.json mandatory.json; do
    if [ -e "$WORK/src/$item" ]; then
        cp "$WORK/src/$item" "$DEST/"
    fi
done
chmod -R u=rwX,go=rX "$DEST"

echo "[novnc] Installed noVNC ${VERSION} into $DEST."
