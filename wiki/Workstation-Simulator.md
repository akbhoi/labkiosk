# Workstation Simulator

A Docker container that behaves like an enrolled thin client — real agent, real extension, real Chromium, real telemetry — viewable in your browser through noVNC. No hardware required.

---

## What is inside

```text
[ Container: labkiosk-client-01 ]
├── Xvfb                  :0 display buffer, 1920x1080x24
├── Openbox               stripped rc.xml, same as the real image
├── x11vnc                localhost:5900, password from /tmp/labkiosk/vnc.pass
├── websockify            bridges :5900 to port 6080 with the noVNC client
├── Chromium              --kiosk, loading /opt/labkiosk/extension
└── agent.py              status, screenshots via scrot, policy sync
```

> The image is defined by the **repository-root `Dockerfile`**, not by anything in `docker-test/`. There used to be a near-identical `docker-test/Dockerfile`; it drifted out of step — it lost `alsa-utils`, so the teacher's `mute` command failed in that variant alone — and was removed. `docker-test/` holds the entrypoint and its docs.

---

## Deliberate differences from real hardware

These three are intentional, and each one matters when you are reasoning about a bug:

| Aspect | Simulator | Real image |
| :--- | :--- | :--- |
| **Chromium sandbox** | `--no-sandbox`, because container processes run as root | Full sandbox, running as unprivileged `kiosk` |
| **websockify binding** | `0.0.0.0:6080`, so you can view it from the host | `127.0.0.1:6080`, reachable only through a Cloudflare Tunnel |
| **Agent API** | `127.0.0.1:8888` — **unchanged** | `127.0.0.1:8888` |

The agent's loopback binding is preserved exactly, which is why you drive the setup wizard from the simulated noVNC screen rather than from your host browser.

**Never launch Chromium with `--disable-web-security`**, in either environment.

---

## Running it

```bash
# From the repository root: builds from your working tree
docker compose up -d

# ...or use the published image instead of building
docker compose pull && docker compose up -d
```

Open `http://localhost:6080/vnc.html`. The VNC password is `labkiosk`.

> The image **bakes the client source in** — the Dockerfile copies `agent.py`, the extension, and the wizard into it. A *pulled* image therefore runs `main`'s client code, not your edits. While working on the client, use `docker compose up -d --build`, or use the `docker cp` recipes below.

The container also mounts `./distro-builder/config/includes.chroot/opt/labkiosk` at `/opt/labkiosk`.

---

## Enrolling the simulated workstation

1. With the control plane running (`cd cloudflare-control && pnpm dev`), open `http://localhost:8787/admin?tenant=demo`.
2. **Settings → Workstation Enrollment Key** → copy the key.
3. In the noVNC window: subdomain `demo`, identifier `PC-01`, and that key.
4. **Connect & Register Workstation.**

What happens:

- The agent posts to `http://host.docker.internal:8787/api/devices/enroll`.
- The worker returns a device token and the school's portal URL.
- The agent writes `/etc/chromium/policies/managed/policies.json`.
- The browser watchdog restarts Chromium once so it lands on the portal under the new policy.
- The workstation appears on the dashboard with sub-second thumbnail telemetry.

---

## Interactive development

### Agent changes

```bash
docker cp distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  labkiosk-client-01:/opt/labkiosk/agent/agent.py

docker exec labkiosk-client-01 pkill -f agent.py
```

The supervisor loop in `entrypoint.sh` relaunches it immediately.

### Extension changes

Manifest V3 extensions are parsed at browser launch, so this needs a Chromium restart rather than an agent restart:

```bash
docker cp distro-builder/config/includes.chroot/opt/labkiosk/extension \
  labkiosk-client-01:/opt/labkiosk/

docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile
```

The watchdog relaunches Chromium within a second.

### Logs

```bash
docker exec labkiosk-client-01 tail -n 50 /tmp/lab-agent.log
```

### Screenshots

```bash
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png
docker cp labkiosk-client-01:/tmp/verify.png .
```

**Verify every UI change on a screenshot, not on a log line.** The agent logging a command as executed proves only that the agent ran; it does not prove the student saw anything.

---

## Environment variables

Set in `docker-compose.yml`:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `WORKER_URL` | `http://host.docker.internal:8787` | Control plane target. Point it at a deployed worker to test against staging. |
| `LABKIOSK_DOMAIN` | `labkiosk.akbhoi.com` | Base platform domain shown in the wizard |
| `VNC_PASSWORD` | `labkiosk` | The noVNC session password |
| `LABKIOSK_REMOTE_HOST` | *(empty)* | Optional hostname to report as `remoteHost`, exercising the Remote Control button |

---

## Reset

```bash
docker compose down -v
docker compose up -d
```

Back to an un-enrolled first-boot state. All ephemeral state — browser profile, session cache, VNC secret — lives in `/tmp` and goes with the container.

---

## What the simulator cannot test

| Not covered | Test it with |
| :--- | :--- |
| Bootloaders, BIOS vs UEFI | Hyper-V Gen 2 and VirtualBox VMs |
| `overlayroot="tmpfs"` behaviour | A real live boot |
| The disk installer | A VM with a spare virtual disk |
| TTY masking, VT switching, polkit | Real hardware or a full VM |
| Chromium's sandbox | The real image — the simulator disables it |
| Cloudflare Tunnel | A provisioned tunnel |

Use it for the agent, the extension, telemetry, the wizard, and anything about the control plane. For anything about booting, use a VM.

→ [Quickstart](Quickstart) · [Client Agent](Client-Agent) · [Browser Extension](Browser-Extension) · [Testing Guide](Testing-Guide)
