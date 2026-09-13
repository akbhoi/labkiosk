FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install Xvfb, Openbox, Chromium, VNC, noVNC, and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    openbox \
    chromium \
    x11vnc \
    novnc \
    websockify \
    python3 \
    scrot \
    xdotool \
    fonts-liberation \
    fonts-noto-core \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Openbox, Chromium policies, Kiosk wrapper, and Agent from root context
COPY distro-builder/config/includes.chroot/etc/openbox /etc/openbox
COPY distro-builder/config/includes.chroot/etc/chromium/policies/managed /etc/chromium/policies/managed
COPY distro-builder/config/includes.chroot/opt/labkiosk /opt/labkiosk
COPY docker-test/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /opt/labkiosk/agent/agent.py /opt/labkiosk/wrapper/app.js

EXPOSE 6080 8888

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
