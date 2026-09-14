# Remote Control & Cloudflare Tunnel Architecture

[← Back to Documentation Hub](../README.md#documentation-hub)

An in-depth guide to the secure, zero-exposure remote desktop architecture in Lab Kiosk, powering one-click interactive teacher supervision via embedded noVNC and Cloudflare Tunnels.

---

## 🌟 Architecture & Security Model

Lab Kiosk enables teachers to take interactive control of student thin clients directly from the web-based Teacher Lab Dashboard without exposing workstations to the local school network or requiring inbound firewall ports.

```text
[ Teacher Browser ]
        │  1. Clicks "Remote Control" on PC-01
        ▼
[ Teacher Lab Dashboard (/admin) ]
        │  2. Retrieves ephemeral VNC password & tunnel URL from /api/clients
        │  3. Opens modal embedding noVNC viewer
        ▼
[ Cloudflare Tunnel Edge (pc-01.labkiosk.institution.edu) ]
        │  4. Secure outbound tunnel (HTTPS/WSS)
        ▼
[ Student Workstation: Thin Client (RAM-only OS) ]
        ├── cloudflared daemon (forwards WSS to 127.0.0.1:6080)
        ├── websockify (bridges 127.0.0.1:6080 ──▶ localhost:5900)
        ├── x11vnc (running on display :0, authenticated by /tmp/labkiosk/vnc.secret)
        └── Python Agent (reports ephemeral VNC secret & tunnel host over telemetry)
```

### Security Invariants

1. **Loopback-Only Bindings:**
   - Both `x11vnc` (`localhost:5900`) and `websockify` (`127.0.0.1:6080`) are bound strictly to the loopback interface on production kiosk images.
   - Workstations **never** expose VNC or web sockets on the local area network (`0.0.0.0`), preventing student-to-student snooping or unauthorized LAN traversal.
2. **Ephemeral Per-Boot Passwords:**
   - At every system startup, `/etc/openbox/autostart` generates a cryptographically random, temporary VNC password:
     ```bash
     head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12
     ```
   - Saved in RAM to `/tmp/labkiosk/vnc.secret` (permissions `0600`, owned by unprivileged `kiosk` user).
   - Passwords are never written to permanent disk and vanish upon power-off or reboot.
3. **Authenticated Out-of-Band Key Exchange:**
   - The workstation's Python agent reads `/tmp/labkiosk/vnc.secret` and transmits it alongside the tunnel hostname over the HTTPS telemetry channel (`POST /api/telemetry`).
   - The request is authenticated with the workstation's private device bearer token.
   - The control plane stores `vnc_password` and `remote_host` in D1 (`client_devices`), scoped strictly to the school's `tenant_id`.
   - Only teachers authenticated to that specific school can read the workstation's remote control credentials from `/api/clients`.
4. **Zero Manual Password Entry:**
   - When a teacher clicks **Remote Control** on a client card, the dashboard embeds an HTML5 noVNC iframe and passes the session credentials directly via encrypted URL parameters or postMessage, connecting automatically.

---

## 🔧 Workstation Tunnel Provisioning

Because Lab Kiosk runs as an immutable live system copied into RAM (`toram`), individual workstation tunnel credentials cannot be baked into a generic base ISO.

### 1. Tunnel Prerequisites
- A Cloudflare Zero Trust account with Cloudflare Tunnels enabled.
- A public domain or subdomain (e.g. `*.labkiosk.institution.edu`).
- The `cloudflared` binary pinned in the build (see `distro-builder/config/includes.chroot/usr/share/labkiosk/cloudflared.pin`).

### 2. Workstation Configuration File
On the client, the `cloudflared-kiosk.service` automatically starts when `/etc/cloudflared/config.yml` is present:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: pc-01.labkiosk.institution.edu
    service: http://127.0.0.1:6080
  - service: http_status:404
```

The Python agent inspects `/etc/cloudflared/config.yml`, parses the first `hostname:` under `ingress:`, and reports `pc-01.labkiosk.institution.edu` as its `remoteHost` in telemetry heartbeats.

### 3. Provisioning Strategies for Production Labs
Since the live image boots from a read-only USB or network boot target:
- **Strategy A: Per-Lab Site Overlay:** Build a site-specific ISO or USB drive with `/etc/cloudflared/` pre-populated for that lab's machines.
- **Strategy B: Persistence Partition:** Create a second, small ext4 partition on the bootable USB drive labeled `labkiosk-data` to persist `/etc/cloudflared/`.
- **Strategy C: Dynamic Tunnel Enrolment:** Script the first-boot onboarding to fetch tunnel tokens securely using an automated school deployment secret.

> [!NOTE]
> Without a Cloudflare Tunnel configured, all other teacher features function normally: live 3-second thumbnails, screen freeze lock curtains, broadcast URLs, browser reload, and remote shutdown. Only the interactive remote control session requires the tunnel.

---

## 🧪 Testing in the Docker Simulator

The local Docker simulator (`docker-test/`) simulates remote control without physical tunnels:

1. **Start the simulator and control plane:**
   ```bash
   # Terminal 1: Cloudflare control plane
   cd cloudflare-control && pnpm dev

   # Terminal 2: Docker simulator
   docker compose up -d
   ```
2. **Configure Remote Host (Optional):**
   In `docker-compose.yml`, set:
   ```yaml
   environment:
     - LABKIOSK_REMOTE_HOST=localhost:6080
   ```
   Or access the display directly at `http://localhost:6080/vnc.html` using the default password `labkiosk`.

---

## 🔍 Troubleshooting Remote Control

| Symptom | Root Cause | Solution |
| :--- | :--- | :--- |
| **noVNC prompts for a password** | Workstation has not completed its first heartbeat after boot, or `/tmp/labkiosk/vnc.secret` is missing. | Verify the workstation is enrolled. Wait 3 seconds for the initial telemetry cycle to record the password in D1. |
| **noVNC shows "Failed to connect to server"** | Cloudflare Tunnel is not running on the target machine, or DNS does not point to Cloudflare. | Ensure `cloudflared-kiosk.service` is active (`systemctl status cloudflared-kiosk`) and `/etc/cloudflared/config.yml` exists. |
| **"Remote Control" button is disabled** | The device has no `remote_host` registered and no default `TUNNEL_DOMAIN` is set in control plane variables. | Configure `TUNNEL_DOMAIN` in Cloudflare Dashboard, or ensure workstation reports `remoteHost` in telemetry. |
| **Screen is black or sluggish** | Low network bandwidth or thin client CPU constrained by high framerate. | noVNC automatically adapts to WAN latencies. Ensure hardware acceleration is enabled in thin client BIOS. |
