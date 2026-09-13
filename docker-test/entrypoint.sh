#!/bin/bash

echo "========================================================"
echo "  Starting Lab Kiosk Simulator in Docker"
echo "  Virtual Resolution: 1920x1080x24"
echo "========================================================"

export DISPLAY=:0

# 1. Start virtual X11 framebuffer (Xvfb)
echo "[1/5] Initializing virtual display server (Xvfb)..."
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
Xvfb :0 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &

# Wait for Xvfb display socket to be ready
echo "Waiting for X11 display socket..."
for i in $(seq 1 30); do
  if [ -e /tmp/.X11-unix/X0 ]; then
    echo "X11 display :0 is ready."
    break
  fi
  sleep 0.2
done

# 2. Start Openbox Window Manager
echo "[2/5] Starting locked Openbox session..."
openbox --config-file /etc/openbox/rc.xml >/tmp/openbox.log 2>&1 &
sleep 0.5

# 3. Start TigerVNC / x11vnc bridge
echo "[3/5] Starting VNC bridge on localhost:5900..."
x11vnc -display :0 -forever -shared -rfbport 5900 -localhost -quiet -bg

# 4. Start noVNC web server on port 6080
echo "[4/5] Starting in-browser noVNC gateway on port 6080..."
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

# 5. Start Lab Agent
echo "[5/5] Starting Lab Kiosk Agent..."
mkdir -p /etc/labkiosk
cat << EOF > /etc/labkiosk/config.json
{
  "clientId": "${CLIENT_ID:-PC-01}",
  "clientNum": ${CLIENT_NUM:-1},
  "workerUrl": "${WORKER_URL:-http://host.containers.internal:8787}"
}
EOF

# Run agent in background watchdog loop
(
  while true; do
    python3 /opt/labkiosk/agent/agent.py >> /tmp/lab-agent.log 2>&1
    sleep 2
  done
) &

echo "========================================================"
echo "  Kiosk is READY!"
echo "  Open on your laptop: http://localhost:6080/vnc.html"
echo "========================================================"

# Launch Chromium in Kiosk mode (Restart loop)
while true; do
  rm -rf /tmp/chromium-cache /tmp/chromium-profile
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
    --remote-debugging-port=9222 \
    --disable-web-security \
    --load-extension=/opt/labkiosk/extension \
    --disable-extensions-except=/opt/labkiosk/extension \
    --autoplay-policy=no-user-gesture-required \
    "${DEFAULT_HOMEPAGE:-https://www.khanacademy.org}" || true
  sleep 1
done
