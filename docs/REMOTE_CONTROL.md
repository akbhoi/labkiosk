# Remote Control Architecture

[← Back to Documentation Hub](../README.md#documentation-hub)

An in-depth guide to the secure, zero-exposure remote desktop architecture in Lab Kiosk, powering one-click interactive operator supervision via noVNC and a relay on the console's own address.

---

## 🌟 Architecture & Security Model

Lab Kiosk enables operators to take interactive control of user thin clients directly from the web-based Operator Lab Dashboard without exposing workstations to the local organization network or requiring inbound firewall ports.

```text
[ Operator Browser ]
        │  1. Clicks "Remote Control" on PC-01
        ▼
[ Operator Lab Dashboard (/admin) ]
        │  2. Opens /console/remote (noVNC from /novnc/) with the per-boot VNC password in the fragment
        │  3. POST /api/clients/remote-session → the hub tells PC-01 {"type":"remote","session":…}
        ▼
[ RemoteRelay Durable Object (one per workstation, on the console's own address) ]
        │  4. Pairs the viewer's WebSocket (/api/console/remote) with the agent's (/api/devices/remote)
        ▼
[ User Workstation: Thin Client (RAM-only OS) ]
        ├── Python Agent (outbound WSS to the relay, pipes it to 127.0.0.1:5900)
        └── x11vnc (running on display :0, loopback only, authenticated by /tmp/labkiosk/vnc.secret)
```

The workstation only makes **outbound** connections to the console's own address, the same one its
control channel already uses. There is no tunnel, DNS record, route or Access application per
workstation, so nothing to provision and no per-zone or per-account limit to reach. The full
contract is in [API.md](API.md) (*Remote Control through the console*).

### Security Invariants

1. **The relay authenticates, not the VNC password:**
   - A session is opened only by an operator signed in to the console with the `workstations`
     permission for that organization, and it is joined only with the one-time session token the
     Worker issued for it (the relay keeps only its SHA-256). The viewer's side must be the same
     operator who opened it; the workstation's side must present its device bearer token.
   - Both sides must join within 60 seconds; a session lasts at most four hours, either side
     closing ends it, and a new session for the same workstation replaces the old one. Every
     session is written to the audit log (`device.remote_control`).
   - Remote Control needs an agent on the WebSocket control channel (`/api/devices/ws`): the
     session request travels over it. Agents still on the HTTP heartbeat cannot join.
2. **Loopback-Only Bindings:**
   - `x11vnc` listens on `localhost:5900` only (`-localhost`). Only the agent, on the same machine,
     connects to it, and pipes it to the relay.
   - Workstations **never** expose VNC or web sockets on the local area network (`0.0.0.0`), preventing user-to-user snooping or unauthorized LAN traversal.
3. **Ephemeral Per-Boot Passwords:**
   - At every system startup, `/etc/openbox/autostart` generates a random, temporary VNC password:

     ```bash
     head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-8
     ```

   - Saved in RAM to `/tmp/labkiosk/vnc.secret` (permissions `0600`, owned by unprivileged `kiosk` user).
   - Passwords are never written to permanent disk and vanish upon power-off or reboot.
   - The session runs with `-noclipboard -noremote -nocmds`: without the first, the VNC clipboard
     is bidirectional and everything a user copies is readable by whoever holds a session.

   > [!IMPORTANT]
   > **Eight characters is the ceiling, not a choice.** The RFB protocol truncates passwords to
   > 8 characters, so this secret is ~32 bits however it is generated — lengthening it changes
   > nothing, because the extra characters are discarded before they reach the wire. It is a
   > guard against an accidental connection, **not** against someone who wants in. The
   > authentication that matters is the relay's: the console sign-in, the `workstations`
   > permission and the one-time session token.
4. **Authenticated Out-of-Band Key Exchange:**
   - The workstation's Python agent reads `/tmp/labkiosk/vnc.secret` and reports it as `vncPassword` over its authenticated control channel (the WebSocket to the organization's hub, or `POST /api/telemetry` on older agents).
   - The request is authenticated with the workstation's private device bearer token.
   - The control plane keeps `vnc_password` in D1 (`client_devices`), scoped strictly to the organization's `tenant_id`.
   - Only operators authenticated to that specific organization can read the workstation's remote control credentials from `/api/clients`.
5. **Zero Manual Password Entry:**
   - When an operator clicks **Remote Control** on a client card, the dashboard opens the console's own viewer page (`/console/remote`) with the VNC password in the URL fragment, which browsers never send. The viewer reads the fragment, removes it from the address, and connects automatically.

> [!NOTE]
> Every other operator feature (live screen thumbnails, lock curtains, broadcast URLs, browser
> reload, remote shutdown) works over the same control channel and needs nothing extra.

---

## 🧪 Testing in the Docker Simulator

The local Docker simulator (`docker-test/`) runs the same agent, so Remote Control from the console
works against it through the relay:

1. **Start the simulator and control plane:**

   ```bash
   # Terminal 1: Cloudflare control plane
   cd cloudflare-control && pnpm dev

   # Terminal 2: Docker simulator
   docker compose up -d
   ```

2. **Open Remote Control** on the simulated workstation's card in the console.

The simulator also runs its own websockify and noVNC on port 6080, published only on the host's
`127.0.0.1`, so a developer can watch the simulated screen at `http://localhost:6080/vnc.html`
(the container prints its random VNC password in its log, or set `VNC_PASSWORD`). That gateway is a simulator convenience: a real workstation has no
websockify or noVNC.

---

## 🔍 Troubleshooting Remote Control

| Symptom | Root Cause | Solution |
| :--- | :--- | :--- |
| **"This workstation is not connected to the console right now"** | `POST /api/clients/remote-session` answered `409`: the workstation holds no control-channel WebSocket to its organization's hub (offline, rebooting, or on the HTTP heartbeat). | Check the workstation is online and enrolled, then try again. |
| **The viewer says it is waiting for the workstation to answer, then the session ends** | The agent is too old to join the relay (it predates the WebSocket control channel or the `remote` message). The session ends after 60 seconds with no workstation side. | Update the workstation to a current image. |
| **The viewer says the workstation asked for a VNC password the console does not have yet** | The agent has not reported `vncPassword` since boot, or `/tmp/labkiosk/vnc.secret` is missing. | Wait a few seconds after boot and try again; check `vncPassword` in `GET /api/clients`. |
| **Screen is black or sluggish** | Low network bandwidth or thin client CPU constrained by high framerate. | noVNC automatically adapts to WAN latencies. Ensure hardware acceleration is enabled in thin client BIOS. |
