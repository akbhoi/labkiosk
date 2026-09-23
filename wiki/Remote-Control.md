# Remote Control

One-click interactive remote desktop from the teacher dashboard, with **no inbound port on the school's network**.

---

## How it works

```text
[ Teacher browser ]
       |  1. Clicks "Remote Control" on PC-01
       v
[ Teacher Lab Dashboard /admin ]
       |  2. Reads vncPassword + remoteHost from GET /api/clients
       |  3. Opens a modal embedding the noVNC viewer
       v
[ Cloudflare Tunnel edge: pc-01.labkiosk.example.edu ]
       |  4. Outbound-only tunnel (HTTPS / WSS)
       v
[ Student workstation ]
       |-- cloudflared        forwards to 127.0.0.1:6080
       |-- websockify         bridges 127.0.0.1:6080 -> localhost:5900
       |-- x11vnc             display :0, auth from /tmp/labkiosk/vnc.pass
       `-- agent.py           reports the secret + tunnel host over telemetry
```

The workstation makes an **outbound** connection to Cloudflare. Nothing listens on the school LAN, and no firewall rule is needed.

---

## The per-boot secret

At every boot, `/etc/openbox/autostart` generates a fresh VNC password:

```bash
VNC_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-8)"
x11vnc -storepasswd "$VNC_SECRET" "$VNC_PASSWD_FILE"
chmod 600 "$VNC_PASSWD_FILE"
(umask 077 && printf '%s' "$VNC_SECRET" > "$VNC_SECRET_FILE")
```

- `/tmp/labkiosk/vnc.pass` — the x11vnc password file, mode `0600`
- `/tmp/labkiosk/vnc.secret` — the plaintext, mode `0600`, owned by `kiosk`, so the agent can report it

Both live in `/tmp` on the RAM overlay. Nothing is written to persistent storage and everything vanishes at power-off.

The session runs with `-noclipboard -nocmd`. Without the first, the VNC clipboard is bidirectional: everything a student copies is readable by whoever holds a session, and anything in the viewer's clipboard can be pasted into the kiosk. `-nocmd` disables x11vnc's own remote-control channel, which is not used here.

### Why eight characters

**Eight characters is the ceiling, not a choice.** The RFB protocol truncates passwords to 8 characters, so this secret is about 32 bits however it is generated — lengthening it changes nothing, because the extra characters are discarded before they reach the wire.

It is a guard against an *accidental* connection, **not** against someone who wants in. The authentication that matters has to sit at the tunnel edge.

---

## Cloudflare Access is mandatory

`websockify` serves the **complete noVNC web UI** on the tunnel hostname. That makes `https://pc-01.<domain>` a public, internet-reachable remote-control endpoint for a classroom machine. The only thing between the open internet and a student's live desktop is the 8-character RFB secret above.

**Put a Cloudflare Access policy in front of every workstation hostname before the first tunnel goes live.**

In Cloudflare Zero Trust, add a self-hosted application covering `*.labkiosk.<your-domain>` and scope the policy to your teaching staff's identity provider group or email domain. Cloudflare then authenticates the teacher at the edge and the tunnel never carries an unauthenticated request.

Without it, the RFB secret is the entire access-control story, and it is not strong enough to be one.

> `cloudflared-kiosk.service` is sandboxed — `NoNewPrivileges`, `ProtectSystem=strict`, an empty `CapabilityBoundingSet`, and a `@system-service` syscall filter — to bound what a compromise of the tunnel binary could reach. That is **containment, not authentication**, and not a substitute for the Access policy.

---

## Key exchange

The teacher never types a password. Here is how the secret gets from the workstation to the browser:

1. `agent.py` reads `/tmp/labkiosk/vnc.secret` and `/etc/cloudflared/config.yml`.
2. It sends both in the three-second heartbeat, **authenticated with the workstation's own device bearer token**.
3. The control plane stores `vnc_password` and `remote_host` on `client_devices`, scoped to the school's `tenant_id`.
4. Only an authenticated admin of *that* school can read them back from `GET /api/clients`.
5. The dashboard embeds a noVNC frame and passes the credentials to it directly.

Both fields are sent **only when present**, so the control plane keeps what it already knows rather than clearing it on a heartbeat where the file was momentarily unreadable.

---

## Provisioning tunnels

Because the client is an immutable RAM-overlay system, per-workstation tunnel credentials cannot be baked into a generic ISO.

### Prerequisites

- A Cloudflare Zero Trust account with Tunnels enabled.
- A domain or subdomain, e.g. `*.labkiosk.institution.edu`.
- The `cloudflared` binary, pinned in `distro-builder/config/includes.chroot/usr/share/labkiosk/cloudflared.pin`. An unset checksum builds without the binary; a wrong one **fails the build**.

### The workstation config

`cloudflared-kiosk.service` starts automatically when `/etc/cloudflared/config.yml` exists:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: pc-01.labkiosk.institution.edu
    service: http://127.0.0.1:6080
  - service: http_status:404
```

The agent parses the first `hostname:` under `ingress:` and reports it as `remoteHost`.

### Getting that file onto each machine

| Strategy | Approach | Suits |
| :--- | :--- | :--- |
| **A — Per-lab overlay** | Build a site-specific ISO with `/etc/cloudflared/` pre-populated | A lab imaged all at once |
| **B — Persistence partition** | A second ext4 partition labelled `labkiosk-data` on the boot USB holding `/etc/cloudflared/` | Live-USB deployments |
| **C — Dynamic enrolment** | Script first-boot to fetch tunnel tokens with a deployment secret | Large or growing fleets |

`LABKIOSK_REMOTE_HOST` overrides the parsed hostname, which is what the simulator uses.

---

## Everything works without a tunnel

This is worth stating clearly, because the tunnel is the fiddliest part of a deployment and it is **optional**:

| Feature | Needs a tunnel? |
| :--- | :--- |
| Live three-second thumbnails | No |
| Lock curtain | No |
| Broadcast | No |
| Reload, reboot, shutdown, clear session, mute | No |
| Allowlist and policy sync | No |
| **Interactive remote control** | **Yes** |

Deploy a whole lab, run it for a term, and add tunnels later if you find you want them.

---

## Testing in the simulator

```bash
# Terminal 1
cd cloudflare-control && pnpm dev

# Terminal 2
docker compose up -d
```

Open `http://localhost:6080/vnc.html`; the password is `labkiosk`. Optionally set in `docker-compose.yml`:

```yaml
environment:
  - LABKIOSK_REMOTE_HOST=localhost:6080
```

> In the container `websockify` binds `0.0.0.0:6080` so you can see the simulated display from your host. **On the real image it binds strictly to `127.0.0.1:6080`** and is reachable only through the tunnel. An open noVNC port gives anyone on the school Wi-Fi full keyboard and mouse control of the workstation.

→ [Workstation Simulator](Workstation-Simulator)

---

## Troubleshooting

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| noVNC asks for a password | No heartbeat since boot, or `/tmp/labkiosk/vnc.secret` is missing | Confirm the workstation is enrolled; wait one telemetry cycle |
| "Failed to connect to server" | Tunnel is not running, or DNS does not point at Cloudflare | `systemctl status cloudflared-kiosk`; confirm `/etc/cloudflared/config.yml` exists |
| **Remote Control** button disabled | No `remote_host` reported and no `TUNNEL_DOMAIN` configured | Set `TUNNEL_DOMAIN` in the dashboard, or provision a tunnel |
| Black or sluggish screen | Bandwidth or thin-client CPU | noVNC adapts to WAN latency; check hardware acceleration in firmware |
| Anyone on the internet can reach the viewer | No Cloudflare Access policy | Add one now — see above |

→ [Kiosk Hardening](Kiosk-Hardening) · [Security Model](Security-Model) · [Client Agent](Client-Agent)
