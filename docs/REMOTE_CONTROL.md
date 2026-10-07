# Remote Control & Cloudflare Tunnel Architecture

[← Back to Documentation Hub](../README.md#documentation-hub)

An in-depth guide to the secure, zero-exposure remote desktop architecture in Lab Kiosk, powering one-click interactive operator supervision via embedded noVNC and Cloudflare Tunnels.

---

## 🌟 Architecture & Security Model

Lab Kiosk enables operators to take interactive control of user thin clients directly from the web-based Operator Lab Dashboard without exposing workstations to the local organization network or requiring inbound firewall ports.

```text
[ Operator Browser ]
        │  1. Clicks "Remote Control" on PC-01
        ▼
[ Operator Lab Dashboard (/admin) ]
        │  2. Retrieves ephemeral VNC password & tunnel URL from /api/clients
        │  3. Opens modal embedding noVNC viewer
        ▼
[ Cloudflare Tunnel Edge (pc-01.labkiosk.example.com) ]
        │  4. Secure outbound tunnel (HTTPS/WSS)
        ▼
[ User Workstation: Thin Client (RAM-only OS) ]
        ├── cloudflared daemon (forwards WSS to 127.0.0.1:6080)
        ├── websockify (bridges 127.0.0.1:6080 ──▶ localhost:5900)
        ├── x11vnc (running on display :0, authenticated by /tmp/labkiosk/vnc.secret)
        └── Python Agent (reports ephemeral VNC secret & tunnel host over telemetry)
```

### Security Invariants

1. **Loopback-Only Bindings:**
   - Both `x11vnc` (`localhost:5900`) and `websockify` (`127.0.0.1:6080`) are bound strictly to the loopback interface on production kiosk images.
   - Workstations **never** expose VNC or web sockets on the local area network (`0.0.0.0`), preventing user-to-user snooping or unauthorized LAN traversal.
2. **Ephemeral Per-Boot Passwords:**
   - At every system startup, `/etc/openbox/autostart` generates a random, temporary VNC password:

     ```bash
     head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-8
     ```

   - Saved in RAM to `/tmp/labkiosk/vnc.secret` (permissions `0600`, owned by unprivileged `kiosk` user).
   - Passwords are never written to permanent disk and vanish upon power-off or reboot.
   - The session runs with `-noclipboard -nocmd`: without the first, the VNC clipboard is
     bidirectional and everything a user copies is readable by whoever holds a session.

   > [!IMPORTANT]
   > **Eight characters is the ceiling, not a choice.** The RFB protocol truncates passwords to
   > 8 characters, so this secret is ~32 bits however it is generated — lengthening it changes
   > nothing, because the extra characters are discarded before they reach the wire. It is a
   > guard against an accidental connection, **not** against someone who wants in. The
   > authentication that matters has to sit at the tunnel edge; see the next section.
3. **Authenticated Out-of-Band Key Exchange:**
   - The workstation's Python agent reads `/tmp/labkiosk/vnc.secret` and transmits it alongside the tunnel hostname over its authenticated control channel (the WebSocket to the organization's hub, or `POST /api/telemetry` on older agents).
   - The request is authenticated with the workstation's private device bearer token.
   - The control plane stores `vnc_password` and `remote_host` in D1 (`client_devices`), scoped strictly to the organization's `tenant_id`.
   - Only operators authenticated to that specific organization can read the workstation's remote control credentials from `/api/clients`.
4. **Zero Manual Password Entry:**
   - When an operator clicks **Remote Control** on a client card, the dashboard embeds an HTML5 noVNC iframe and passes the session credentials directly via encrypted URL parameters or postMessage, connecting automatically.

---

## 🔧 Workstation Tunnel Provisioning

Because Lab Kiosk runs as an immutable system whose writes all land in a RAM overlay (`overlayroot="tmpfs"`), individual workstation tunnel credentials cannot be baked into a generic base ISO. There are two ways to give each workstation a tunnel: let the console create them (below, recommended), or provision them by hand (the sections after it).

### Automatic tunnels

Settings → Domains → **Automatic Remote Control Tunnels**. Under **Workstation addresses** the organization picks where its workstations live:

- **Lab Kiosk's remote-control domain**, for an organization with no domain: workstations get `<organization>-<workstation>.<platform domain>` (`greenwood` / `PC-01` → `greenwood-pc-01.labkiosk.dev`) in the platform's own Cloudflare account. The organization supplies only who may connect. Offered when the server has the `REMOTE_TUNNEL_PLATFORM_*` settings (`docs/DEPLOYMENT.md`). That domain is never the console's own, whose session cookie a browser would send to every workstation address under it. An address longer than one DNS label (63 characters), or one another workstation already holds, is refused and listed in Errors & Warnings; rename the workstation.
- **My own Cloudflare domain**, below.

For its own domain the organization supplies:

- a **domain** that is a zone on its own Cloudflare account, e.g. `example.com`. Workstations get `<workstation>.example.com` (`PC-01` → `pc-01.example.com`), one label under the zone, so the zone's free Universal SSL certificate covers them. A domain two labels deep (`vnc.example.com`) needs Advanced Certificate Manager on that zone. A domain under the platform's own domain is refused: its certificate covers only one label, and the platform's Worker answers that label;
- its **Cloudflare account ID**;
- an **API token** with *Account · Cloudflare Tunnel · Edit*, *Account · Access: Apps and Policies · Edit*, *Zone · DNS · Edit* and *Zone · Zone · Read* on that zone. It is checked before it is saved, stored encrypted (AES-GCM, server secret `REMOTE_TUNNEL_KEY`), and never shown again;
- **who may connect**: email addresses or whole email domains. They become one reusable Cloudflare Access policy, so Zero Trust must be set up on the account.

Each workstation then asks the console for its tunnel at start and every five minutes (`GET /api/devices/tunnel`). On its first request the console creates, in the organization's account (or the platform's), a remotely managed tunnel forwarding `<workstation>.<domain>` to `http://127.0.0.1:6080`, the proxied CNAME (comment `Lab Kiosk Remote Control`; an existing record it did not create is left alone and reported), and an Access application using the policy, which allows framing because the console shows noVNC in a frame. The agent stores the run token on `LABKIOSK_DATA` (`/etc/labkiosk/tunnel.token`); `cloudflared-labkiosk.path` restarts `cloudflared-labkiosk.service`, which runs cloudflared as a throwaway unprivileged user. Failures appear in Settings → Errors & Warnings and are retried after ten minutes.

Removing a workstation deletes its tunnel, DNS record and Access application first. **Turn Off** deletes them for every workstation, then the policy and the stored token.

### 1. Tunnel Prerequisites

- A Cloudflare Zero Trust account with Cloudflare Tunnels enabled.
- A public domain or subdomain (e.g. `*.labkiosk.example.com`).
- The `cloudflared` binary pinned in the build (see `distro-builder/config/includes.chroot/usr/share/labkiosk/cloudflared.pin`).

### 2. Cloudflare Access Is Mandatory, Not Optional

`websockify` serves the complete noVNC web UI on the tunnel hostname, so `https://pc-01.<domain>`
is a public, internet-reachable remote-control endpoint for a room machine. The only thing
between the open internet and a user's live desktop is the 8-character RFB secret above.

**Put a Cloudflare Access policy in front of every workstation hostname before the first tunnel
goes live.** In Cloudflare Zero Trust, add a self-hosted application covering
`*.labkiosk.<your-domain>` and scope the policy to your administrators' identity provider group
or e-mail domain. Cloudflare then authenticates the operator at the edge and the tunnel never
carries an unauthenticated request. Without it, the RFB secret is the entire access control
story, and it is not strong enough to be one.

The `cloudflared-kiosk.service` unit is sandboxed (`NoNewPrivileges`, `ProtectSystem=strict`,
an empty `CapabilityBoundingSet`, and a `@system-service` syscall filter) to bound what a
compromise of the tunnel binary could reach. That is containment, not authentication — it is not
a substitute for the Access policy.

### 3. Workstation Configuration File

On the client, the `cloudflared-kiosk.service` automatically starts when `/etc/cloudflared/config.yml` is present:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: pc-01.labkiosk.example.com
    service: http://127.0.0.1:6080
  - service: http_status:404
```

The Python agent inspects `/etc/cloudflared/config.yml`, parses the first `hostname:` under `ingress:`, and reports `pc-01.labkiosk.example.com` as its `remoteHost` in telemetry heartbeats.

### 4. Provisioning Strategies for Production Labs

Since the live image boots from a read-only USB or network boot target, and an installed disk boots a copy of the same read-only system image (`images/<version>/` on `LABKIOSK_ROOT`):

- **Strategy A: Per-Lab Site Overlay:** Build a site-specific ISO or USB drive with `/etc/cloudflared/` pre-populated for that lab's machines. Installing from that ISO copies its system image, so the configuration carries onto the installed disk.
- **Strategy B: Persistence Partition:** Not supported by the stock image. Lab Kiosk mounts no partition by label: a live session mounts none, and an installed workstation mounts only its own `LABKIOSK_DATA`, by the UUID GRUB passes as `labkiosk.data=`, at `/etc/labkiosk`. Persisting `/etc/cloudflared/` there needs an image change (a bind mount from the data partition, like the NetworkManager profiles).
- **Strategy C: Dynamic Tunnel Enrolment:** Script the first-boot onboarding to fetch tunnel tokens securely using an automated organization deployment secret.

> [!NOTE]
> Without a Cloudflare Tunnel configured, all other operator features function normally: live screen thumbnails, screen freeze lock curtains, broadcast URLs, browser reload, and remote shutdown. Only the interactive remote control session requires the tunnel.

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
| **noVNC prompts for a password** | Workstation has not completed its first heartbeat after boot, or `/tmp/labkiosk/vnc.secret` is missing. | Verify the workstation is enrolled. The password is reported as soon as the workstation connects; check `vncPassword` in `GET /api/clients`. |
| **noVNC shows "Failed to connect to server"** | Cloudflare Tunnel is not running on the target machine, or DNS does not point to Cloudflare. | Ensure `cloudflared-kiosk.service` is active (`systemctl status cloudflared-kiosk`) and `/etc/cloudflared/config.yml` exists. |
| **"Remote Control" button is disabled** | The device has no `remote_host` registered and no default `TUNNEL_DOMAIN` is set in control plane variables. | Configure `TUNNEL_DOMAIN` in Cloudflare Dashboard, or ensure workstation reports `remoteHost` in telemetry. |
| **Browser says the workstation "uses an unsupported protocol"** | The address is two labels under a domain whose certificate covers one (`pc-01.org.labkiosk.org` against `*.labkiosk.org`), so the TLS handshake fails. | Use a tunnel domain on a zone you control whose certificate covers `*.<tunnel domain>`. The console refuses one under the platform's own domain. |
| **Screen is black or sluggish** | Low network bandwidth or thin client CPU constrained by high framerate. | noVNC automatically adapts to WAN latencies. Ensure hardware acceleration is enabled in thin client BIOS. |
