# ==============================================================================
# Lab Kiosk OS - Dockerized Kiosk Image (labkiosk)
# Runs the full Debian 12 Lab Kiosk workstation environment in Docker with noVNC.
# ==============================================================================
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
    alsa-utils \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-color-emoji \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Openbox, Chromium policies, and the Agent from the repository root
COPY distro-builder/config/includes.chroot/etc/openbox /etc/openbox
COPY distro-builder/config/includes.chroot/etc/chromium/policies/managed /etc/chromium/policies/managed
COPY distro-builder/config/includes.chroot/opt/labkiosk /opt/labkiosk
COPY docker-test/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /opt/labkiosk/agent/agent.py

EXPOSE 6080

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
