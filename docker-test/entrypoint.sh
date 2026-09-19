#!/bin/bash
#
# Lab Kiosk workstation simulator.
#
# This mirrors the real client (distro-builder/config/includes.chroot) closely
# enough to exercise enrolment, telemetry and remote commands without hardware.
# The one deliberate difference is that noVNC is published so you can watch the
# simulated screen from your laptop; the real image keeps it on loopback.
#
# Chromium keeps its sandbox, exactly as on the real image: the container runs as
# the unprivileged kiosk user (USER in the Dockerfile). --no-sandbox is used only
# when someone starts the container as root anyway, because Chromium refuses to
# run as root otherwise -- that is a fallback, not the intended way to run this.

set -u

if [ "$(id -u)" -eq 0 ]; then
    CHROMIUM_SANDBOX_FLAGS="--no-sandbox"
    echo "WARNING: running as root, so Chromium's sandbox is disabled."
    echo "         Run this image as its kiosk user (the default) instead."
else
    CHROMIUM_SANDBOX_FLAGS=""
fi

# Chromium reads its managed policy at startup. A read-only container mounts a
# tmpfs over the policy directory, so restore the boot-time policy when it is
# missing rather than let the browser start with no blocklist.
POLICY_DIR=/etc/chromium/policies/managed
if [ ! -f "$POLICY_DIR/policies.json" ] && [ -f /usr/local/share/labkiosk-boot-policy.json ]; then
    mkdir -p "$POLICY_DIR" 2>/dev/null \
        && cp /usr/local/share/labkiosk-boot-policy.json "$POLICY_DIR/policies.json" \
        && echo "Restored the boot-time Chromium policy into $POLICY_DIR."
fi

echo "========================================================"
echo "  Starting Lab Kiosk Simulator in Docker"
echo "  Virtual Resolution: 1920x1080x24"
echo "========================================================"

export DISPLAY=:0

# Chromium needs a writable home: its crash handler creates a database under
# $HOME/.config and aborts at startup without one ("chrome_crashpad_handler:
# --database is required", then a trace trap and a black screen). With a
# read-only root filesystem /home/kiosk is not writable, so fall back to /tmp,
# which is a tmpfs in every configuration this image runs in.
export HOME="${HOME:-/home/kiosk}"
if ! mkdir -p "$HOME/.config" 2>/dev/null; then
    HOME=/tmp/kiosk-home
    export HOME
    mkdir -p "$HOME/.config"
    echo "Root filesystem is read-only; using $HOME as the browser's home."
fi
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"

# 1. Virtual X11 framebuffer
echo "[1/5] Initializing virtual display server (Xvfb)..."
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
# -s 0: never blank, matching the BlankTime 0 the real image sets in Xorg.
Xvfb :0 -screen 0 1920x1080x24 -s 0 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &

echo "Waiting for X11 display socket..."
for _ in $(seq 1 30); do
  if [ -e /tmp/.X11-unix/X0 ]; then
    echo "X11 display :0 is ready."
    break
  fi
  sleep 0.2
done

# 2. Openbox window manager
echo "[2/5] Starting locked Openbox session..."
openbox --config-file /etc/openbox/rc.xml >/tmp/openbox.log 2>&1 &
sleep 0.5

# 3. x11vnc, password-protected exactly as on the real image
echo "[3/5] Starting VNC bridge on localhost:5900..."
mkdir -p /tmp/labkiosk && chmod 700 /tmp/labkiosk
VNC_PASSWD_FILE=/tmp/labkiosk/vnc.pass
# Random per container unless one is supplied. A fixed default would be a
# published password on an endpoint that grants full keyboard and mouse control;
# the RFB protocol caps it at 8 characters, so it is weak by construction and the
# proxy or tunnel in front of it has to carry the real authentication.
VNC_SECRET="${VNC_PASSWORD:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-8)}"
x11vnc -storepasswd "$VNC_SECRET" "$VNC_PASSWD_FILE" >/dev/null 2>&1
chmod 600 "$VNC_PASSWD_FILE"
# The agent reports this to the teacher console so "Remote Control" autoconnects.
(umask 077 && printf '%s' "$VNC_SECRET" > /tmp/labkiosk/vnc.secret)
x11vnc -display :0 -forever -shared -rfbport 5900 -localhost \
  -rfbauth "$VNC_PASSWD_FILE" -quiet -bg
echo "      VNC password for this container: $VNC_SECRET"

# 4. noVNC gateway. Published on 0.0.0.0 only because this is a throwaway test
#    container you view from the host; the real image binds it to loopback and
#    exposes it through the Cloudflare Tunnel instead.
echo "[4/5] Starting in-browser noVNC gateway on port 6080..."
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 localhost:5900 >/tmp/websockify.log 2>&1 &

# 5. Lab Kiosk agent.
#    No config is written here: the workstation enrols through the setup wizard
#    exactly as a real one does, using the school's enrollment key. The agent's
#    API binds to loopback inside the container, so drive the wizard from the
#    noVNC screen rather than from the host.
echo "[5/5] Starting Lab Kiosk Agent..."
mkdir -p /etc/labkiosk
if [ -n "${WORKER_URL:-}" ]; then
  echo "      Control plane for enrolment: $WORKER_URL"
  export WORKER_URL
fi
if [ -n "${LABKIOSK_DOMAIN:-}" ]; then
  echo "      Base domain: $LABKIOSK_DOMAIN"
  export LABKIOSK_DOMAIN
fi
if [ -n "${LABKIOSK_REMOTE_HOST:-}" ]; then
  echo "      Remote-control hostname reported to the console: $LABKIOSK_REMOTE_HOST"
  export LABKIOSK_REMOTE_HOST
fi

(
  while true; do
    python3 /opt/labkiosk/agent/agent.py >>/tmp/lab-agent.log 2>&1
    echo "[entrypoint] agent exited; restarting in 2s" >>/tmp/lab-agent.log
    sleep 2
  done
) &

# Ask the agent where the kiosk should point right now: the setup wizard until the
# workstation is enrolled, the school portal afterwards. Re-read on every relaunch
# so the agent's post-enrolment browser restart lands on the school's page under
# the freshly written Chromium policy.
read_kiosk_url() {
  for _ in $(seq 1 50); do
    TARGET="$(curl -fsS --max-time 1 http://127.0.0.1:8888/api/status 2>/dev/null \
      | sed -n 's/.*"targetUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [ -n "$TARGET" ]; then
      printf '%s' "$TARGET"
      return 0
    fi
    sleep 0.2
  done
  printf '%s' "http://127.0.0.1:8888/setup"
}

echo "========================================================"
echo "  Kiosk is READY"
echo "  Open on your laptop: http://localhost:6080/vnc.html"
echo "  Then complete the setup wizard on the kiosk screen"
echo "  using your school subdomain and enrollment key."
echo "========================================================"

# Chromium kiosk watchdog.
# --disable-web-security is intentionally absent here too; it was disabling the
# same-origin policy for every page the simulated student visited.
#
# $CHROMIUM_SANDBOX_FLAGS is deliberately unquoted: it is empty in the normal,
# unprivileged case, and an empty quoted argument would reach Chromium as a URL.
while true; do
  rm -rf /tmp/chromium-cache /tmp/chromium-profile
  KIOSK_URL="$(read_kiosk_url)"
  chromium \
    $CHROMIUM_SANDBOX_FLAGS \
    --kiosk \
    --no-first-run \
    --noerrdialogs \
    --disable-infobars \
    --disable-pinch \
    --disable-session-crashed-bubble \
    --overscroll-history-navigation=0 \
    --disk-cache-dir=/tmp/chromium-cache \
    --user-data-dir=/tmp/chromium-profile \
    --enable-gpu-rasterization \
    --ignore-gpu-blocklist \
    --load-extension=/opt/labkiosk/extension \
    --disable-extensions-except=/opt/labkiosk/extension \
    --autoplay-policy=no-user-gesture-required \
    -- "$KIOSK_URL" || true
  sleep 1
done
