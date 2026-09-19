# Local Workstation Simulator

[← Back to Documentation Hub](../README.md#documentation-hub)

An interactive Docker-based thin client workstation simulator with embedded noVNC display, designed to test the Lab Kiosk client OS, setup wizard, extension, and agent without physical hardware.

---

## 🌟 Overview & Simulator Architecture

The simulator closely mirrors the production live Debian 12 kiosk environment (`distro-builder/config/includes.chroot`), allowing developers to test the full lifecycle: first-boot enrolment, telemetry heartbeats, policy updates, screen freezes, broadcast navigations, and remote control.

### Architecture Stack inside Container

```text
[ Docker Container: labkiosk-client-01 ]
├── Xvfb (:0 display buffer, 1920x1080x24)
├── Openbox Window Manager (stripped rc.xml)
├── x11vnc (localhost:5900, protected by /tmp/labkiosk/vnc.pass)
├── websockify (bridges localhost:5900 to port 6080 with noVNC HTML5 client)
├── Chromium Kiosk Process (runs with --kiosk and loads /opt/labkiosk/extension)
└── Python 3 Agent (monitors status, captures screenshots via scrot, syncs policy)
```

### Deliberate Differences vs. Physical Hardware
1. **Gateway Binding:** `websockify` binds to `0.0.0.0:6080` *inside* the container so you can view the simulated display, but the port is published only on the host's `127.0.0.1`. In the physical ISO, `websockify` binds strictly to `127.0.0.1:6080` and is reachable only through a per-workstation Cloudflare Tunnel.
2. **Sandboxing:** the same as the real image — Chromium runs sandboxed as the unprivileged `kiosk` user. `--no-sandbox` is used only if someone starts the container as root, and the entrypoint warns when that happens.
3. **Loopback Preservation:** The agent's local API (`127.0.0.1:8888`) remains bound to loopback inside the container, exactly as on physical hardware. You drive the setup wizard from the simulated noVNC screen rather than your host browser.

---

## 🔒 How the container is locked down

The simulator browses the open web, so `docker-compose.yml` treats it as untrusted:

| Setting | Why |
| :--- | :--- |
| Runs as the unprivileged `kiosk` user (uid 1000) | A browser exploit lands on a normal account, not root. It also lets Chromium keep its own sandbox: renderers run in their own user and PID namespaces with no capabilities. |
| `cap_drop: ALL` plus `cap_add: SYS_CHROOT` | `SYS_CHROOT` is the single capability Chromium's sandbox needs — its zygote chroots itself before spawning renderers. Without it every tab dies with `Check failed: sys_chroot("/proc/self/fdinfo/")` and the screen stays black. |
| `security_opt: no-new-privileges` | Nothing setuid can raise privileges. Safe because the sandbox uses user namespaces rather than the setuid helper. |
| `read_only: true` with tmpfs for `/tmp`, `/run`, `/etc/labkiosk` and the Chromium policy directory | Nothing survives a restart, matching the real image's RAM overlay. `/tmp` is mounted `exec` because Chromium maps files there, and the entrypoint moves the browser's home to `/tmp` because `/home/kiosk` is read-only. Because `/etc/labkiosk` is a tmpfs, the wizard shows its amber "cannot remember an enrolment" warning here — correctly: an enrolment made in the simulator does not survive a restart, and you re-enrol each session. |
| `mem_limit`, `pids_limit`, `shm_size` | A runaway page cannot take the host down with it. |
| Port published on `127.0.0.1:6080` only | noVNC is protected by an 8-character RFB secret, which the protocol caps; on `0.0.0.0` anyone on the same network reaches a live desktop. To share it, put an authenticating proxy in front, or use a Cloudflare Tunnel with Access. |
| Random VNC password per container | Printed in the startup log. A fixed default would be a published password for keyboard and mouse control. |

If your host forbids unprivileged user namespaces, Chromium cannot start its sandbox. Prefer fixing
the host; only as a last resort run the container as root, where the entrypoint falls back to
`--no-sandbox` and says so in the log.

### Verifying what you pulled

Published images are built for `linux/amd64` and `linux/arm64`, carry an SBOM and build provenance,
and are signed with cosign against the publishing workflow's identity:

```bash
cosign verify ghcr.io/akbhoi/labkiosk \
  --certificate-identity-regexp '^https://github.com/akbhoi/labkiosk/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Release tags also publish `X.Y.Z`, `X.Y` and `X`, so a deployment can pin a line that still receives
fixes instead of following `latest`.

### A smaller build

`--build-arg WITH_INTL_FONTS=0` drops the Noto fonts and saves about 55 MB. Latin text still renders
through `fonts-liberation`, but non-Latin scripts and emoji do not, so use it only where that is
acceptable.

---

## 🚀 Quickstart: Launching the Simulator

> [!NOTE]
> The simulator image is defined by the **repository-root `Dockerfile`**, not by anything in this
> directory. There used to be a near-identical `docker-test/Dockerfile`; it drifted out of step
> (it lost `alsa-utils`, so the teacher's "mute" command failed in that variant alone) and was
> removed. This directory holds the entrypoint and these docs.

### 1. Prerequisites
- A rootful Docker-compatible engine with Docker Compose v2 (`docker compose`).
- The Cloudflare Control Plane running locally (`pnpm dev` in `cloudflare-control/`) or deployed to Cloudflare Workers.

### 2. Start the Simulator
From the repository root:
```bash
docker compose up -d
```

Compose builds the image locally from your working tree and tags it
`ghcr.io/akbhoi/labkiosk:latest`. The published image is available under the same name, so you can
skip the build entirely:

```bash
docker compose pull      # fetch the published image instead of building
docker compose up -d
```

> [!IMPORTANT]
> The image **bakes the client source in** (`Dockerfile` copies `agent.py`, the extension and the
> wizard into it), so a *pulled* image runs `main`'s client code, not your local edits. While
> working on the client, use `docker compose up -d --build`, or push individual files into the
> running container with the `docker cp` recipes in
> [Interactive Development Workflows](#%EF%B8%8F-interactive-development-workflows) below.

### 3. Open the In-Browser Workstation Display
Navigate to:
```text
http://localhost:6080/vnc.html
```
- **VNC Password:** random per container, printed in the startup log (`docker compose logs | grep "VNC password"`). Set `VNC_PASSWORD` to pin one.
- You will see the simulated thin-client desktop rendering the **First-Boot Setup Wizard**.

---

## 🎓 Simulating First-Boot Enrolment

1. Open the Teacher Lab Dashboard in your host browser:
   `http://localhost:8787/admin?tenant=demo`
2. Go to **Settings → Workstation Enrollment Key** and copy the active key.
3. In the simulated noVNC window (`http://localhost:6080/vnc.html`):
   - **School Subdomain:** `demo`
   - **Workstation Identifier:** `PC-01`
   - **Enrollment Key:** Paste or type the key copied from the teacher dashboard.
4. Click **Connect & Register Workstation**.
5. **What happens under the hood:**
   - The agent verifies credentials with `POST http://host.docker.internal:8787/api/devices/enroll`.
   - The worker validates the key and returns a persistent device bearer token and the school's portal URL.
   - The agent writes the initial Chromium enterprise policy (`/etc/chromium/policies/managed/policies.json`).
   - The browser watchdog restarts Chromium once so it lands on the student learning portal under the newly written policy.
   - The workstation appears live on the Teacher Dashboard with sub-second thumbnail telemetry!

---

## 🛠️ Interactive Development Workflows

The simulator mounts `./distro-builder/config/includes.chroot/opt/labkiosk` as a volume into `/opt/labkiosk`.

### 1. Testing Agent Updates
If you modify `agent.py`:
```bash
# Restart the agent daemon inside the container
docker exec labkiosk-client-01 pkill -f agent.py
```
The watchdog loop in `entrypoint.sh` will immediately relaunch `agent.py`.

### 2. Testing Browser Extension Changes
Manifest V3 extensions are parsed by Chromium on browser launch. To test changes to `content.js` or `background.js`:
```bash
# Restart Chromium
docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile
```
The watchdog loop in `entrypoint.sh` will relaunch Chromium within one second with the updated extension.

### 3. Viewing Agent Logs
```bash
docker exec labkiosk-client-01 tail -n 50 /tmp/lab-agent.log
```

### 4. Taking Headless Screenshots
Always verify visual rendering directly on screen rather than relying solely on log outputs:
```bash
# Capture virtual display :0 to a file inside the container
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/screen.png

# Copy screenshot to host to inspect
docker cp labkiosk-client-01:/tmp/screen.png ./screen.png
```

---

## ⚙️ Environment Variables Reference

Configure these in `docker-compose.yml` or via shell exports:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TZ` | `Asia/Kolkata` | Container timezone (IST). Baked into the image; override here to run the simulator on another clock. |
| `WORKER_URL` | `http://host.docker.internal:8787` | Target Cloudflare Worker control plane. Set to your production URL (e.g. `https://labkiosk.akbhoi.com`) to test remote staging. |
| `LABKIOSK_DOMAIN` | `labkiosk.akbhoi.com` | Base platform domain. |
| `VNC_PASSWORD` | random per container | Password for the local noVNC session; printed in the startup log when generated. |
| `LABKIOSK_REMOTE_HOST` | *(empty)* | Optional public hostname (e.g. Cloudflare Tunnel) that routes to port 6080. If set, reported to the teacher console for remote assistance. |

---

## 🧹 Teardown & Resetting State

To completely reset the simulator back to an un-enrolled, fresh first-boot state:
```bash
docker compose down -v
docker compose up -d
```
All ephemeral state in `/tmp` (browser profile, session caches, VNC secrets) is wiped on container recreation.
