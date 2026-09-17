# Quickstart

Run the whole platform — control plane and a simulated student workstation — on one machine in about five minutes. No thin clients, no Cloudflare account, no ISO build.

## Prerequisites

- **Node.js v22 or newer.** The test suite uses Node's native `node:sqlite`, which is not available earlier.
- **pnpm v9 or newer** (`npm install -g pnpm`).
- **A rootful Docker-compatible engine** with Compose v2, for the workstation simulator.

---

## 1. Start the control plane

```bash
cd cloudflare-control
pnpm install

# Local secrets. With a D1 binding present the worker refuses to seed a default
# super admin, so this step is required rather than optional.
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```ini
SUPER_ADMIN_EMAIL=admin@labkiosk.local
SUPER_ADMIN_PASSWORD=LocalDevPassword123!
```

Then:

```bash
pnpm dev
```

`predev` runs `wrangler d1 migrations apply labkiosk-db --local` first, applying every file in `migrations/` to the local D1 store under `.wrangler/state/v3/d1`. The worker will not serve a database whose migrations are missing.

The platform is now on `http://localhost:8787`:

| Surface | URL |
| :--- | :--- |
| Public landing page | `http://localhost:8787/` |
| Student Learning Portal | `http://localhost:8787/?tenant=demo` |
| Teacher Lab Dashboard | `http://localhost:8787/admin?tenant=demo` |
| Super Admin console | `http://localhost:8787/super` |

The `?tenant=` override works here only because `localhost` is a recognised development host. In production the `Host` header is the sole authority — see [Architecture Overview](Architecture-Overview#tenant-resolution).

---

## 2. Create a school

1. Open `http://localhost:8787/` and register a school. Pick subdomain `demo` so the URLs above resolve.
2. Sign in to `http://localhost:8787/super` with the credentials from `.dev.vars`.
3. **Approve** the pending registration. A school stays `pending` — and its workstations cannot enrol — until a super admin approves it.
4. Sign in to the Teacher Lab Dashboard at `http://localhost:8787/admin?tenant=demo`.
5. Go to **Settings → Workstation Enrollment Key** and generate one. Schools start with an empty key, and an empty key authenticates nothing.

---

## 3. Launch the workstation simulator

From the repository root:

```bash
docker compose up -d
```

Compose builds the simulator image from your working tree and tags it `ghcr.io/akbhoi/labkiosk:latest`. To skip the build and use the published image instead:

```bash
docker compose pull && docker compose up -d
```

> The image **bakes the client source in**, so a pulled image runs `main`'s client code rather than your edits. While working on `agent.py` or the extension, use `docker compose up -d --build`, or push files into the running container — see [Workstation Simulator](Workstation-Simulator#interactive-development).

Open the simulated screen:

```text
http://localhost:6080/vnc.html
```

The VNC password is `labkiosk`. You should see the thin-client desktop showing the **first-boot setup wizard**.

---

## 4. Enrol the workstation

In the noVNC window — not your host browser; the agent's API is loopback-only and the wizard is served from inside the container:

| Field | Value |
| :--- | :--- |
| School subdomain | `demo` |
| Workstation identifier | `PC-01` |
| Enrollment key | the key from step 2 |

Click **Connect & Register Workstation**. Under the hood:

1. The agent posts to `http://host.docker.internal:8787/api/devices/enroll`.
2. The worker validates the key and returns a persistent device bearer token plus the school's portal URL.
3. The agent writes `/etc/labkiosk/config.json` (mode `0600`) with the token, the worker URL, and the target URL.
4. The agent writes the school's allowlist into `/etc/chromium/policies/managed/policies.json`.
5. Because Chromium reads managed policy only at startup, the agent sets `pendingBrowserRestart` and the watchdog relaunches the browser once — otherwise the freshly enrolled kiosk would sit on a "This page is blocked" screen.

Within three seconds `PC-01` appears on the Teacher Dashboard with a live thumbnail.

---

## 5. Try the teacher controls

From `http://localhost:8787/admin?tenant=demo`:

- **Lock all screens** — a full-screen curtain appears in the simulator with your message.
- **Broadcast a URL** — every workstation navigates there at once and stays there.
- **Reset to portal** — clears the broadcast and returns the lab to the launcher.
- **Add a portal app** — the card shows up on the student portal, and its host is added to the effective allowlist automatically.

→ [Teacher Dashboard Guide](Teacher-Dashboard-Guide) for what each control actually does.

---

## 6. Run the checks

```bash
# Strict typecheck: src/ against Workers types, test/ against Node types
pnpm --prefix cloudflare-control run typecheck

# Integration and security suite
pnpm --prefix cloudflare-control test
```

Both must be clean before any change is committed. → [Testing Guide](Testing-Guide)

---

## Teardown

```bash
docker compose down -v
```

`-v` discards the container's volumes, resetting the simulator to an un-enrolled first-boot state. All ephemeral state — browser profile, session cache, VNC secret — lives in `/tmp` and vanishes with the container.

---

## Where to go next

| Goal | Page |
| :--- | :--- |
| Understand what you just ran | [Architecture Overview](Architecture-Overview) |
| Build a real bootable ISO | [Building the ISO](Building-the-ISO) |
| Install onto real hardware | [Installation Guide](Installation-Guide) |
| Deploy to Cloudflare for real | [Production Deployment](Production-Deployment) |
| Something did not work | [Troubleshooting](Troubleshooting) |
