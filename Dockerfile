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
# ------------------------------------------------------------------------------
# Stage 1: the noVNC web client, from the same pinned, checksum-verified release
# the ISO ships (distro-builder/config/includes.chroot/usr/share/labkiosk/
# novnc.pin). Debian's novnc package would add Node.js and OpenStack Python
# libraries (~130 MB) to the final image; this stage also keeps curl's download
# of it out of the final layers.
# ------------------------------------------------------------------------------
FROM debian:bookworm-slim AS novnc

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY distro-builder/config/includes.chroot/usr/share/labkiosk/novnc.pin \
     distro-builder/config/includes.chroot/usr/share/labkiosk/install-novnc.sh /tmp/novnc/
RUN sh /tmp/novnc/install-novnc.sh /tmp/novnc/novnc.pin /opt/novnc

# ------------------------------------------------------------------------------
# Stage 2: the simulator itself.
# ------------------------------------------------------------------------------
FROM debian:bookworm-slim

# org.opencontainers.image.source is what links the GHCR package back to this
# repository -- without it the package page has no source, no README and no
# inherited visibility.
LABEL org.opencontainers.image.source="https://github.com/akbhoi/labkiosk" \
      org.opencontainers.image.description="Lab Kiosk workstation simulator: Debian 12 kiosk environment with Chromium, x11vnc and noVNC." \
      org.opencontainers.image.licenses="SEE LICENSE IN LICENSE"

ENV DEBIAN_FRONTEND=noninteractive

# Asia/Kolkata (IST) everywhere, so container logs and anything the browser
# renders read in the same clock as the school running it. tzdata is already in
# the base image; only the link and the name have to be set, and TZ covers the
# libraries that read the variable instead of /etc/localtime.
ENV TZ=Asia/Kolkata
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Set to 0 to build without the Noto fonts (~55 MB smaller). Latin text still
# renders through fonts-liberation, but non-Latin scripts and emoji do not, so
# leave it on for anything a school will look at:
#   docker build --build-arg WITH_INTL_FONTS=0 -t labkiosk:slim .
ARG WITH_INTL_FONTS=1

# tzdata, locales and xkb-data are the three tables the setup wizard's
# Language & Region step reads its options from -- the same ones the ISO
# carries, so the step can be exercised here as it is on a workstation.
# One layer: update, install, and drop the package lists, so the lists never
# reach a committed layer. alsa-utils is required -- the agent's "mute" command
# shells out to amixer. chromium-sandbox carries the setuid helper: this image
# runs Chromium as an unprivileged user with its sandbox on, as the real one does.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    openbox \
    chromium \
    chromium-sandbox \
    x11vnc \
    websockify \
    python3 \
    scrot \
    xdotool \
    alsa-utils \
    tzdata \
    locales \
    xkb-data \
    fonts-liberation \
    ca-certificates \
    curl \
    && if [ "$WITH_INTL_FONTS" = "1" ]; then \
         apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-color-emoji; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# The simulator runs as this unprivileged user, so a browser exploit lands on a
# normal account inside the container rather than on root, and Chromium's own
# sandbox works. uid 1000 matches the kiosk user on the real image, which keeps
# the bind-mounted source in docker-compose.yml readable.
RUN useradd --uid 1000 --create-home --shell /bin/bash kiosk

# Copy order is deliberate: least-frequently-changed first, so that editing the
# agent or the extension invalidates only the final layer instead of rebuilding
# everything below it.
COPY --from=novnc /opt/novnc /usr/share/novnc
COPY distro-builder/config/includes.chroot/etc/openbox /etc/openbox
COPY distro-builder/config/includes.chroot/etc/chromium/policies/managed /etc/chromium/policies/managed

# The single declaration of the static Chromium policy. sync_chromium_policies()
# reloads it on every allowlist change and fails closed without it -- the agent
# would keep the boot-time policy forever and log a refusal each heartbeat.
COPY distro-builder/config/includes.chroot/usr/share/labkiosk /usr/share/labkiosk

COPY --chmod=0755 docker-test/entrypoint.sh /entrypoint.sh

# Highest churn during development, so it goes last.
COPY --chmod=0755 distro-builder/config/includes.chroot/opt/labkiosk /opt/labkiosk

# The same privileged helper the real image ships. It is what answers the
# wizard's Language & Region step, and listing the timezones, locales and
# keyboard layouts it offers needs no privileges -- so the step works here
# even though this container has no systemd to apply them to.
COPY --chmod=0755 distro-builder/config/includes.chroot/usr/local/sbin/labkiosk-localization /usr/local/sbin/labkiosk-localization

# A pristine copy of the boot-time policy, outside both paths docker-compose.yml
# bind-mounts and outside the directory a read-only container mounts a tmpfs
# over. The entrypoint restores it from here when the policy directory is empty,
# so the browser never starts with no blocklist at all.
RUN cp /etc/chromium/policies/managed/policies.json /usr/local/share/labkiosk-boot-policy.json \
    && mkdir -p /etc/labkiosk \
    && chown kiosk:kiosk /etc/labkiosk /etc/chromium/policies/managed \
    && chmod 0700 /etc/labkiosk

USER kiosk
ENV HOME=/home/kiosk

EXPOSE 6080

# The agent's loopback API is the one thing that proves the workstation is
# actually alive: X, the window manager and the agent must all be up before it
# answers. start-period covers Xvfb plus the agent's first boot.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8888/api/status >/dev/null || exit 1

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
