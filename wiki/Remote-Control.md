# Remote Control

One-click interactive remote desktop from the admin console, with **no inbound port on the organization's network**.

---

## How it works

```text
[ Operator browser ]
       |  1. Clicks "Remote Control" on PC-01
       v
[ Operator Lab Dashboard /admin ]
       |  2. Opens /console/remote (noVNC) with the per-boot password in the address fragment
       |  3. POST /api/clients/remote-session; the hub tells PC-01 to join
       v
[ RemoteRelay on the console's own address ]
       |  4. Pairs the viewer's WebSocket with the agent's and forwards VNC bytes
       v
[ User workstation ]
       |-- agent.py           outbound WSS to the relay, piped to 127.0.0.1:5900
       `-- x11vnc             display :0, loopback only, auth from /tmp/labkiosk/vnc.pass
```

The workstation makes only **outbound** connections to the console, the same address its control channel uses. Nothing listens on the organization LAN, no firewall rule is needed, and there is no tunnel, DNS record or route per workstation.

A session is opened only by an operator signed in to the console with the `workstations` permission, and joined only with the one-time session token the Worker issued for it (the relay keeps only its SHA-256). Both sides must join within 60 seconds; a session lasts at most four hours, either side closing ends it, and a new session for the same workstation replaces the old one. Every session is written to the audit log (`device.remote_control`).

Remote Control needs an agent on the WebSocket control channel (`/api/devices/ws`), because the request to join travels over it. An agent still on the three-second HTTP heartbeat cannot join.

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

The session runs with `-noclipboard -noremote -nocmds`. Without the first, the VNC clipboard is bidirectional: everything a user copies is readable by whoever holds a session, and anything in the viewer's clipboard can be pasted into the kiosk. `-noremote` disables x11vnc's own remote-control channel, which is not used here, and `-nocmds` stops x11vnc from running external commands.

### Why eight characters

**Eight characters is the ceiling, not a choice.** The RFB protocol truncates passwords to 8 characters, so this secret is about 32 bits however it is generated — lengthening it changes nothing, because the extra characters are discarded before they reach the wire.

It is a guard against an *accidental* connection, **not** against someone who wants in. The authentication that matters is the relay's: the console sign-in, the `workstations` permission and the one-time session token.

---

## Key exchange

The operator never types a password. Here is how the secret gets from the workstation to the browser:

1. `agent.py` reads `/tmp/labkiosk/vnc.secret`.
2. It reports it as `vncPassword` over its control channel (the WebSocket to the organization's hub, or the heartbeat on older agents), **authenticated with the workstation's own device bearer token**.
3. The control plane stores `vnc_password` on `client_devices`, scoped to the organization's `tenant_id`.
4. Only an authenticated admin of *that* organization can read it back from `GET /api/clients`.
5. The dashboard opens the console's viewer page with the password in the address fragment, which browsers never send; the viewer reads it, removes it from the address and connects.

The password is sent **only when present**, so the control plane keeps what it already knows rather than clearing it on a heartbeat where the file was momentarily unreadable.

---

## Everything else needs nothing extra

Live thumbnails, the lock curtain, broadcast, reload, reboot, shutdown, clear session, mute and allowlist sync all travel over the same control channel as Remote Control. None of it needs a port, a DNS record or any per-workstation setup.

---

## Testing in the simulator

```bash
# Terminal 1
cd cloudflare-control && pnpm dev

# Terminal 2
docker compose up -d
```

Then click **Remote Control** on the simulated workstation's card: it goes through the relay, as on a real workstation.

The simulator also runs its own websockify and noVNC on port 6080 so you can watch the simulated display at `http://localhost:6080/vnc.html` (the container prints its random VNC password in its log, or set `VNC_PASSWORD`). `docker-compose.yml` publishes it only on the host's `127.0.0.1`: an open noVNC port gives anyone on the same Wi-Fi full keyboard and mouse control. **A real workstation has no websockify or noVNC at all.**

→ [Workstation Simulator](Workstation-Simulator)

---

## Troubleshooting

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| "This workstation is not connected to the console right now" | `POST /api/clients/remote-session` answered `409`: the workstation holds no control-channel WebSocket (offline, rebooting, or on the HTTP heartbeat) | Confirm the workstation is online and enrolled, then try again |
| The viewer says it is waiting for the workstation to answer, then the session ends | The agent is too old to join the relay; with no workstation side, the session ends after 60 seconds | Update the workstation to a current image |
| The viewer says the workstation asked for a VNC password the console does not have yet | No `vncPassword` reported since boot, or `/tmp/labkiosk/vnc.secret` is missing | Wait a few seconds after boot and try again; check `vncPassword` in `GET /api/clients` |
| Black or sluggish screen | Bandwidth or thin-client CPU | noVNC adapts to WAN latency; check hardware acceleration in firmware |

→ [Kiosk Hardening](Kiosk-Hardening) · [Security Model](Security-Model) · [Client Agent](Client-Agent)
