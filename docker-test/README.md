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
├── websockify (bridges localhost:5900 to port 6080 with noVNC HTML5 client; simulator only)
├── Chromium Kiosk Process (runs with --kiosk and loads /opt/labkiosk/extension)
└── Python 3 Agent (monitors status, captures screenshots via scrot, syncs policy)
```

### Deliberate Differences vs. Physical Hardware

1. **Viewing Gateway:** `websockify` binds to `0.0.0.0:6080` *inside* the container so you can watch the simulated display, but the port is published only on the host's `127.0.0.1`. The physical ISO has no websockify or noVNC at all: Remote Control from the console goes through the agent and the console's relay, which works the same against the simulator. The simulator's noVNC is pinned in `docker-test/novnc.pin` and installed by `docker-test/install-novnc.sh`.
2. **Sandboxing:** the same as the real image — Chromium runs sandboxed as the unprivileged `kiosk` user. `--no-sandbox` is used only if someone starts the container as root, and the entrypoint warns when that happens.
3. **Loopback Preservation:** The agent's local API (`127.0.0.1:8888`) remains bound to loopback inside the container, exactly as on physical hardware. You drive the setup wizard from the simulated noVNC screen rather than your host browser.
4. **No Installed Disk:** the container never boots through GRUB, so it has no image store, no one-try boot or rollback (`labkiosk-boot-slots`), and no `/run/labkiosk-update/status.json`; the agent therefore sends no boot reports and the console's **Settings → Errors & Warnings** stays empty for it. Those paths are tested by `distro-builder/tests/vm/boot-test.sh` (QEMU with KVM), which CI runs after every ISO build.

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
| Port published on `127.0.0.1:6080` only | noVNC is protected by an 8-character RFB secret, which the protocol caps; on `0.0.0.0` anyone on the same network reaches a live desktop. To share it, put an authenticating proxy in front; Remote Control from the console needs no port. |
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
> (it lost `alsa-utils`, so the operator's "mute" command failed in that variant alone) and was
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

1. Sign in as the super admin and open the Docker demo's console in your host browser:
   `http://localhost:8787/admin?tenant=docker-demo`
2. Go to **Settings → Workstation Enrollment Key** and copy the active key.
3. In the simulated noVNC window (`http://localhost:6080/vnc.html`):
   - **Organization Subdomain:** `docker-demo`
   - **Workstation Identifier:** `PC-01`
   - **Enrollment Key:** Paste or type the key copied from the admin console.
4. Click **Connect & Register Workstation**.
5. **What happens under the hood:**
   - The agent verifies credentials with `POST http://host.docker.internal:8787/api/devices/enroll`.
   - The worker validates the key and returns a persistent device bearer token and the organization's portal URL.
   - The agent writes the initial Chromium enterprise policy (`/etc/chromium/policies/managed/policies.json`).
   - The browser watchdog restarts Chromium once so it lands on the user portal under the newly written policy.
   - The workstation appears live on the Admin console with sub-second thumbnail telemetry!

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
| `WORKER_URL` | `http://host.docker.internal:8787` | Target Cloudflare Worker control plane. Set to your production URL (e.g. `https://labkiosk.org`) to test remote staging. |
| `LABKIOSK_DOMAIN` | `labkiosk.org` | Base platform domain. |
| `VNC_PASSWORD` | random per container | Password for the local noVNC session; printed in the startup log when generated. |

---

## 🧹 Teardown & Resetting State

To completely reset the simulator back to an un-enrolled, fresh first-boot state:

```bash
docker compose down -v
docker compose up -d
```

All ephemeral state in `/tmp` (browser profile, session caches, VNC secrets) is wiped on container recreation.
