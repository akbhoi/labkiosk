# ==============================================================================
# Lab Kiosk OS - Workstation Simulator (ghcr.io/akbhoi/labkiosk)
#
# Runs the full Debian 12 Lab Kiosk workstation environment in Docker with
# noVNC, so enrolment, telemetry and remote commands can be exercised without
# physical thin clients.
#
# THIS IS THE ONLY SIMULATOR IMAGE. docker-compose.yml and
# .github/workflows/docker-publish.yml both build this file. There used to be a
# near-identical copy at docker-test/Dockerfile; it drifted (it lost alsa-utils,
# so the teacher's "mute" command failed in that variant alone) and was removed.
# docker-test/ keeps the entrypoint and the documentation, not a second image.
# ==============================================================================
FROM debian:bookworm-slim

# org.opencontainers.image.source is what links the GHCR package back to this
# repository -- without it the package page has no source, no README and no
# inherited visibility.
LABEL org.opencontainers.image.source="https://github.com/akbhoi/labkiosk" \
      org.opencontainers.image.description="Lab Kiosk workstation simulator: Debian 12 kiosk environment with Chromium, x11vnc and noVNC." \
      org.opencontainers.image.licenses="BUSL-1.1"

ENV DEBIAN_FRONTEND=noninteractive

# One layer: update, install, and drop the package lists, so the lists never
# reach a committed layer. alsa-utils is required -- the agent's "mute" command
# shells out to amixer.
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

# Copy order is deliberate: least-frequently-changed first, so that editing the
# agent or the extension invalidates only the final layer instead of rebuilding
# everything below it.
COPY distro-builder/config/includes.chroot/etc/openbox /etc/openbox
COPY distro-builder/config/includes.chroot/etc/chromium/policies/managed /etc/chromium/policies/managed

# The single declaration of the static Chromium policy. sync_chromium_policies()
# reloads it on every allowlist change and fails closed without it -- the agent
# would keep the boot-time policy forever and log a refusal each heartbeat.
COPY distro-builder/config/includes.chroot/usr/share/labkiosk /usr/share/labkiosk

COPY --chmod=0755 docker-test/entrypoint.sh /entrypoint.sh

# Highest churn during development, so it goes last.
COPY --chmod=0755 distro-builder/config/includes.chroot/opt/labkiosk /opt/labkiosk

EXPOSE 6080

# The agent's loopback API is the one thing that proves the workstation is
# actually alive: X, the window manager and the agent must all be up before it
# answers. start-period covers Xvfb plus the agent's first boot.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8888/api/status >/dev/null || exit 1

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
