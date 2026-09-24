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
- The simulator container here **cannot reach the host** (not even `host.docker.internal`). For an
  end-to-end run, put the control plane in a container on the simulator's network instead: a
  compose override with a fixed subnet, a `node:24` service running the Worker under `tsx` on the
  in-memory D1 (mount `cloudflare-control/src` read-only), and `WORKER_URL=http://<its private IP>:8787`
  for the simulator — a private IPv4 literal is both an allowed worker URL and a dev host. Publish
  its ports on `127.0.0.1` to drive the consoles from the host; attach sessions server-side in the
  harness rather than typing passwords. Enrol through the agent API
  (`curl -H 'Origin: http://127.0.0.1:8888' -d '{clientId,enrollmentKey,subdomain}' …/api/setup`);
  to re-enrol, POST `/api/setup` again with an admin token from `/api/admin/verify` (the simulator
  has no boot password, so any value verifies), or delete `/etc/labkiosk/config.json` and restart
  the agent. Remove the workstation on the control plane to see the `#reenrol` flow.
- Headless Chromium **inside** the simulator cannot take screenshots: the kiosk's managed policy
  applies to every Chromium there. Screenshot web pages with headless Edge/Chrome on the host.
- Podman copies an image's files into a tmpfs mounted over them (Docker mounts it empty), so a
  root-owned file baked under a tmpfs path is what the container starts with. Hand such files to
  `kiosk` in the Dockerfile — that is why `policies.json` is chowned.

## Hardening (never loosen)

Runs as the unprivileged `kiosk` user, Chromium sandbox **on**, read-only root, `cap_drop: ALL`
except `SYS_CHROOT`, `no-new-privileges`, noVNC published on `127.0.0.1` only. `--no-sandbox` is
only the entrypoint's warned fallback when started as root — never make it unconditional. The
simulator reports as an installed workstation, so the wizard opens on enrolment.

`Running as root without --no-sandbox is not supported`, or `Check failed: sys_chroot("/proc/self/fdinfo/")`
with a black screen, means the container started as root or without `cap_add: SYS_CHROOT` — fix the
container, never the flag.
