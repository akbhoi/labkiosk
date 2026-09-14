#!/bin/bash
#
# Lab Kiosk workstation simulator.
#
# This mirrors the real client (distro-builder/config/includes.chroot) closely
# enough to exercise enrolment, telemetry and remote commands without hardware.
# Two deliberate differences, both container-specific:
#   * Chromium runs with --no-sandbox, because it runs as root in the container.
#   * noVNC is published so you can watch the simulated screen from your laptop.
# Neither is used on the real image.

set -u

echo "========================================================"
echo "  Starting Lab Kiosk Simulator in Docker"
echo "  Virtual Resolution: 1920x1080x24"
echo "========================================================"

export DISPLAY=:0

# 1. Virtual X11 framebuffer
echo "[1/5] Initializing virtual display server (Xvfb)..."
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
Xvfb :0 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &

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
VNC_SECRET="${VNC_PASSWORD:-labkiosk}"
x11vnc -storepasswd "$VNC_SECRET" "$VNC_PASSWD_FILE" >/dev/null 2>&1
chmod 600 "$VNC_PASSWD_FILE"
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
while true; do
  rm -rf /tmp/chromium-cache /tmp/chromium-profile
  KIOSK_URL="$(read_kiosk_url)"
  chromium \
    --no-sandbox \
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
