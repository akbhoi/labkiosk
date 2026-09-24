---
name: labkiosk-simulator
description: Running and verifying Lab Kiosk workstation changes in the Docker workstation simulator (root Dockerfile, docker-compose.yml, docker-test/entrypoint.sh) — starting it, reloading the agent or browser, taking screenshots, and the Windows/Git Bash and networking pitfalls. Use when you need to see a client change (agent, extension, wizard, commands) actually work on screen.
---

# Lab Kiosk — workstation simulator

Authoritative detail: root `AGENTS.md` (simulator hardening) and `docker-test/README.md`.

## Start and reload

```bash
docker compose up -d --no-build          # image ghcr.io/akbhoi/labkiosk; client source is live-mounted
docker exec labkiosk-client-01 pkill -f agent.py                                 # autostart relaunches it
docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile  # watchdog relaunches Chromium
docker exec labkiosk-client-01 tail -n 25 /tmp/lab-agent.log
docker compose down                       # when finished, if it was not running before
```

`docker-compose.yml` mounts `opt/labkiosk`, `labkiosk-localization` and `usr/share/labkiosk`, so
agent, extension, wizard and localization edits are live without a rebuild; the entrypoint itself
is baked into the image (rebuild with `docker build -t ghcr.io/akbhoi/labkiosk .` to change it).
Use plain `docker` commands (a rootful podman machine serves them here).

## Prove it on screen

```bash
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png
docker cp labkiosk-client-01:/tmp/verify.png <scratch>/verify.png
```

Look at the screenshot. "The agent logged the command" proves only that the agent ran. For a
mechanism (e.g. clear-session), measure it too: plant a marker in `/tmp/chromium-profile/Default`,
trigger the action, and check the marker is gone, the profile inode changed and Chromium's PID
changed. To call agent functions in place, load the module in a separate interpreter:
`importlib.util.spec_from_file_location("agent", "/opt/labkiosk/agent/agent.py")`.

## Pitfalls on this Windows machine

- **Git Bash rewrites container paths**: `docker exec … /tmp/x` becomes `C:/Users/…/Temp/x`. Prefix
  with `MSYS_NO_PATHCONV=1`.
- **`pkill -f <pattern>` matches your own shell** if the pattern appears in the command line you
  ran it from (e.g. inside `sh -c '…--user-data-dir=/tmp/chromium-profile…'`). Put the probe in a
  script file and build the pattern at run time.
- Heredocs through the Bash tool can drop or alter backslashes (`\\`, `\b`, `\'`); write scripts
  with a file tool, then run them.
- `python3` is the Microsoft Store stub; use `python` on the host.
- The simulator container here **cannot reach the host** (not even `host.docker.internal`), so it
  cannot stand in for a VM talking to a local `pnpm dev`; test that from Hyper-V instead.

## Hardening (never loosen)

Runs as the unprivileged `kiosk` user, Chromium sandbox **on**, read-only root, `cap_drop: ALL`
except `SYS_CHROOT`, `no-new-privileges`, noVNC published on `127.0.0.1` only. `--no-sandbox` is
only the entrypoint's warned fallback when started as root — never make it unconditional. The
simulator reports as an installed workstation, so the wizard opens on enrolment.

`Running as root without --no-sandbox is not supported`, or `Check failed: sys_chroot("/proc/self/fdinfo/")`
with a black screen, means the container started as root or without `cap_add: SYS_CHROOT` — fix the
container, never the flag.
