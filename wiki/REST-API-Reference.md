# REST API Reference

The complete endpoint catalogue for the Lab Kiosk Cloudflare control plane, plus the client agent's loopback API.

> Endpoints below are verified against `cloudflare-control/src/index.ts`. Where the in-repo `docs/API.md` and the implementation disagree, this page follows the implementation — see [Known documentation drift](#known-documentation-drift).

---

## Conventions

- **Protocol:** HTTPS only in production, enforced by HSTS and edge redirection.
- **Content type:** `application/json; charset=utf-8`, except for HTML pages and redirects.
- **Caching:** API responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **Errors:** `{ "error": "<human-readable message>" }` with the appropriate status.

### Authentication schemes

| Scheme | Header | Used by |
| :--- | :--- | :--- |
| **Session cookie** | `Cookie: labkiosk_session=<hex32>` (`HttpOnly; Secure; SameSite=Lax`) | Operator Lab Dashboard, Super Admin console |
| **Device bearer token** | `Authorization: Bearer <hex32>` | `agent.py` on each workstation, for `/api/telemetry` |
| **Public / key-exchanged** | none, or a one-time `enrollmentKey` in the body | Landing page, sign-in, registration, user portal, enrolment, health probe |

Session tokens are random 32-byte hex strings; only their SHA-256 hash is stored in D1. Device tokens are handled the same way — the plaintext token exists only on the workstation that was issued it.

### Guards

Every route passes through `src/guard.ts` before its handler runs:

| Guard | Rejects with | Applies to |
| :--- | :--- | :--- |
| `resolveTenant()` | `404` | every tenant-scoped route |
| `requireTenantAdmin()` | `401` anonymous, `403` wrong tenant | all `/api/settings/*`, `/api/clients*`, `/api/command`, `/api/whitelist`, `/api/audit-logs`, mutating `/api/portal-sites*` and `/api/broadcast-presets*` |
| `requireSuperAdmin()` | `401` / `403` | all `/api/super/*` |
| `requireDevice()` | `401` | `/api/telemetry` |
| `rejectCrossSiteMutation()` | `403` | every cookie-authenticated `POST`/`DELETE` under `/api/` |

### Rate limiting

- **Sign-in:** repeated failures trigger exponential back-off per identifier, answered with `429 Too Many Requests`.
- **Registration and failed enrolment:** throttled per source address via `rateLimitWait()` / `recordRateLimitHit()` in `db.ts`.

### Payload limits

- **Thumbnails:** capped at 256 KB. Anything larger, or not prefixed `data:image/jpeg;base64,` or `data:image/png;base64,`, is dropped server-side. The agent drops oversized frames before sending, so the heartbeat still lands.
- **Lock messages:** truncated to 280 characters.
- **VNC passwords:** truncated to 64 characters (x11vnc itself uses only the first 8 — see [Remote Control](Remote-Control#why-eight-characters)).
- **Client identifiers:** must match `^[A-Z0-9][A-Z0-9_-]{0,62}$`.
- **URLs:** every navigable URL passes `safeHttpUrl()`, which accepts only `http:`/`https:` and prepends `https://` to scheme-less domains.

---

## Endpoint summary

### Public

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/status` | `GET` | Platform health and the tenant's current kiosk target |
| `/api/auth/register` | `POST` | Register an organization and claim a subdomain |
| `/api/auth/login` | `POST` | Sign in as operator or super admin |
| `/api/portal-sites` | `GET` | List the host tenant's user portal cards |
| `/api/devices/enroll` | `POST` | Exchange an enrollment key for a device token |

### Session-authenticated

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/auth/me` | `GET` | Current user profile and tenant |
| `/api/auth/logout` | `POST` | Invalidate this session and clear the cookie |
| `/api/auth/change-password` | `POST` | Rotate password, revoking the account's other sessions |

### Operator admin

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/clients` | `GET` | Fleet state with live thumbnails and remote-control details |
| `/api/clients/remove` | `POST` | Decommission a workstation and revoke its token |
| `/api/clients/group` | `POST` | Assign workstations to a group |
| `/api/groups` | `GET` `POST` | List and create workstation groups |
| `/api/groups/:id` | `DELETE` | Delete a workstation group |
| `/api/tenant/staff` | `GET` `POST` | List and create delegated staff (requires `staff`; see the delegation limits in `docs/API.md`) |
| `/api/tenant/staff/update` | `POST` | Change a staff account's role or permissions |
| `/api/tenant/staff/:id` | `DELETE` | Remove a staff account and end its sessions |
| `/api/command` | `POST` | Dispatch a command to one, selected, or all workstations |
| `/api/whitelist` | `GET` `POST` | Read and modify the permanent domain allowlist |
| `/api/portal-sites` | `POST` | Add a user portal card |
| `/api/portal-sites/:id` | `DELETE` | Remove a user portal card |
| `/api/broadcast-presets` | `GET` `POST` | List and add quick-launch broadcast shortcuts |
| `/api/broadcast-presets/:id` | `DELETE` | Remove a broadcast shortcut |
| `/api/settings/mode` | `POST` | Switch between `portal` and `single_url` |
| `/api/settings/customization` | `GET` `POST` | Organization branding, portal copy, default lock message |
| `/api/settings/subdomain` | `POST` | Request a subdomain change |
| `/api/settings/enrollment-key` | `GET` `POST` | View or rotate the enrollment key |
| `/api/settings/custom-domain` | `POST` `DELETE` | Request or disconnect a custom domain |
| `/api/audit-logs` | `GET` | Paginated organization audit log |

### Device

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/devices/ws` | `GET` (WebSocket) | The control channel: status and frames up; configuration, commands and frame requests down |
| `/api/telemetry` | `POST` | The HTTP fallback: a three-second heartbeat carrying the same |

### Super admin

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/super/tenants/approve` | `POST` | Approve a pending organization |
| `/api/super/tenants/reject` | `POST` | Reject a pending organization |
| `/api/super/tenants/suspend` | `POST` | Suspend an active organization |
| `/api/super/tenants/reactivate` | `POST` | Reactivate a suspended organization |
| `/api/super/tenants/custom-domain/approve` | `POST` | Approve and bind a custom domain |
| `/api/super/tenants/custom-domain/reject` | `POST` | Reject a requested custom domain |
| `/api/super/tenants/custom-domain/remove` | `POST` | Unbind an assigned custom domain |

### HTML routes

| Path | Serves |
| :--- | :--- |
| `/` | Landing page on the platform apex; User Portal on a tenant host |
| `/` | Organization homepage (organization-authored headline, intro and content blocks) |
| `/home` | User Portal (approved app grid) |
| `/admin` | Operator Lab Dashboard |
| `/super` | Super Admin Master Console |
| `/login`, `/register`, `/contact` | Landing-page sections |
| `/download`, `/iso` | Redirect to `ISO_DOWNLOAD_URL` |

---

## Detailed reference

### `POST /api/devices/enroll`

Exchanges an organization's enrollment key for a persistent device bearer token. This is the only moment a workstation proves who it is with a shared secret; afterwards it holds its own token.

**Access:** public, throttled per source address on failure.

```json
{
  "subdomain": "oakridge",
  "clientId": "PC-01",
  "enrollmentKey": "KEY-ABCD-1234-EFGH",
  "customDomain": "kiosk.oakridge.edu"
}
```

`customDomain` is optional; the agent sends it when the workstation was pointed at a custom domain rather than a platform subdomain.

**`200 OK`**

```json
{
  "status": "ok",
  "deviceToken": "32_byte_hex_bearer_token",
  "clientId": "PC-01",
  "subdomain": "oakridge",
  "organizationName": "Oakridge Holdings",
  "schoolName": "Oakridge Holdings",
  "mode": "portal",
  "targetUrl": "https://oakridge.labkiosk.example.com"
}
```

`schoolName` is also sent, with the same value, for agents installed from an ISO older than the
organization vocabulary. It is deprecated: new code reads `organizationName`, and the field will be
removed once no workstation in the field depends on it.

The agent writes the token to `/etc/labkiosk/config.json` with mode `0600`. On live media that file lives in the RAM overlay and is lost at power-off, which is intended — the workstation is meant to be installed. On an installed disk, `/etc/labkiosk` is a mount point for the `LABKIOSK_DATA` partition, which is what makes a post-install enrolment persist.

**Failure modes:** an empty or wrong key, an unapproved or suspended organization, or a `clientId` failing `CLIENT_ID_PATTERN` are all rejected. Organizations begin with an empty enrollment key, which authenticates nothing until an operator generates one.

---

### `GET /api/devices/ws`

The workstation's control channel: a WebSocket to its organization's OrgHub. Current agents use it
whenever the image has `python3-websocket`.

**Access:** `Authorization: Bearer <deviceToken>` on the upgrade. `401`/`403` when the token or the
organization is refused, `426` without an upgrade.

| Direction | Message |
| :--- | :--- |
| hub → workstation | `{"type":"config", whitelist, mode, targetUrl, broadcastUrl, broadcastEpoch, commands?}` on connect and after every admin change |
| hub → workstation | `{"type":"commands", commands}` the moment a command is dispatched |
| hub → workstation | `{"type":"frames", on, intervalSeconds}` when a console starts or stops showing this screen |
| workstation → hub | `{"type":"status", clientNum, activeUrl, isLocked, vncPassword?, remoteHost?}` on connect and on change |
| workstation → hub | `{"type":"frame", thumbnail}` every `intervalSeconds` while asked |
| workstation → hub | `{"type":"ping"}` every 15 s, byte for byte; answered `{"type":"pong"}` at the edge |

Close codes: `4001` the workstation was removed, `4003` the organization is not active (both send
the screen to re-enrolment), `4000` replaced by a newer connection, `4008` silent for 75 s.

### `GET /api/console/ws`

The Workstations page's live channel. **Access:** a session with the `workstations` permission and
an `Origin` of this site. The console sends `{"type":"watch", clientIds}` for the screens it is
showing and receives `snapshot`, `status`, `frame` and `removed` messages.

### `POST /api/telemetry`

The HTTP heartbeat, called every three seconds by agents without the WebSocket client (and by any
agent whose server has no WebSocket route). It carries the same state as the control channel in
one request and reply.

**Access:** `Authorization: Bearer <deviceToken>`.

**Request** — exactly these keys; `post_telemetry()` in `agent.py` is the reference implementation:

```json
{
  "clientNum": 1,
  "activeUrl": "https://scratch.mit.edu",
  "isLocked": false,
  "thumbnail": "data:image/jpeg;base64,...",
  "vncPassword": "a1b2c3d4",
  "remoteHost": "pc-01.labkiosk.example.edu"
}
```

| Field | Notes |
| :--- | :--- |
| `clientNum` | Integer workstation number; non-numeric values fall back to `1`. |
| `activeUrl` | Validated by `safeHttpUrl()`; falls back to the tenant default. |
| `isLocked` | Whether the lock curtain is currently up. |
| `thumbnail` | Base64 JPEG from `scrot -t 20 -q 35`. **Omitted** when the encoded payload would exceed `MAX_THUMBNAIL_BYTES` (256 KB), so an oversized frame is dropped rather than allowed to bloat a three-second loop. No PIL/Pillow is involved — the agent is standard library only. |
| `vncPassword` | Per-boot ephemeral secret from `/tmp/labkiosk/vnc.secret`. Sent only when present, so the control plane keeps what it already knows otherwise. |
| `remoteHost` | Tunnel hostname from `/etc/cloudflared/config.yml` or `LABKIOSK_REMOTE_HOST`. Sent only when present. |

There is **no `currentUrl` key and no `metrics` object.** The agent collects no CPU, RAM, or storage statistics; do not build a dashboard against fields that do not exist.

**Identity is taken from the token, never the body.** Any `clientId` or tenant the payload claims is discarded.

**`200 OK`**

```json
{
  "status": "ok",
  "commands": [
    { "id": "cmd-123", "action": "lock", "message": "Eyes to the board please." }
  ],
  "whitelist": ["scratch.mit.edu", "khanacademy.org", "oakridge.labkiosk.example.com"],
  "mode": "portal",
  "targetUrl": "https://oakridge.labkiosk.example.com",
  "broadcastUrl": "",
  "broadcastEpoch": 0
}
```

| Field | Notes |
| :--- | :--- |
| `commands` | Pending commands for *this* workstation. The hub records each delivery, so each command executes exactly once rather than on every heartbeat. |
| `whitelist` | Effective allowlist: the organization's own domains plus every portal app host, plus the active broadcast host if it is not already present. Merged into the Chromium managed policy. |
| `targetUrl` | Where the kiosk should point. Validated as `http(s)` by `safe_navigable_url()` before the agent stores it, because it ends up in `window.location`. |
| `broadcastUrl` / `broadcastEpoch` | The authoritative synchronised page. The epoch is a monotonic marker letting a workstation distinguish a new broadcast from a replayed one. |

**`403`** if the organization is not `active` — a suspended organization's workstations stop receiving commands and policy.

---

### `POST /api/command`

Dispatches a remote action to one workstation or the whole lab.

**Access:** organization admin.

**Supported actions** (`ALLOWED_COMMANDS` in `index.ts`, mirrored by `execute_command()` in `agent.py`):

| Action | Effect on the workstation |
| :--- | :--- |
| `lock` | Raises the full-screen lock curtain across every tab, with the message. |
| `unlock` | Drops the curtain. |
| `navigate` | Navigates top-level to `url`. With `resetPortal: true`, returns to the organization portal and clears the broadcast. |
| `reload` | Reloads the current page. |
| `reboot` | Reboots the workstation through logind. |
| `shutdown` | Powers the workstation off. |
| `mute` | Mutes audio output via `alsa-utils`. |

Anything else is rejected with `400 Unsupported action`. There is no `broadcast` action — a broadcast is `navigate` to `target: "all"`, which additionally writes `broadcast_url` and `broadcast_epoch` onto the tenant row.

```json
{ "targets": ["PC-01", "PC-02"], "action": "lock", "message": "Midterm examination is beginning." }
```

```json
{ "target": "all", "action": "navigate", "url": "https://scratch.mit.edu" }
```

```json
{ "target": "all", "action": "navigate", "resetPortal": true }
```

Targeting supports either `targets: string[]` (array of `clientId` strings) or `target: string` (`"all"` or a single `clientId`). Duplicates are dropped, `"all"` replaces named targets, and at most 500 targets are accepted. When `action` is `lock` and no `message` is supplied, the tenant's `default_lock_message` is used.

**`200 OK`** → `{ "status": "ok", "commandId": "cmd-uuid-99" }`

The hub pushes the command to a connected workstation at once; the console sees the new state as soon as the workstation reports it. Every dispatch writes an audit-log row (`command.<action>`).

---

### `GET /api/clients`

Returns the organization's fleet: the D1 registry merged with the hub's live status. `POST` with `{"watch": ["PC-01", …]}` also asks the hub for those screens' frames for the next 10 seconds -- the fallback for a console without its live channel; `thumbnail` is present only for watched, online workstations.

**Access:** organization admin.

```json
{
  "clients": {
    "PC-01": {
      "clientId": "PC-01",
      "clientNum": 1,
      "activeUrl": "https://scratch.mit.edu",
      "isLocked": false,
      "thumbnail": "data:image/jpeg;base64,...",
      "timestamp": 1726300000,
      "lastSeen": "2026-09-14T09:26:40.000Z",
      "online": true,
      "vncPassword": "a1b2c3d4",
      "remoteHost": "pc-01.labkiosk.example.edu"
    }
  }
}
```

`vncPassword` and `remoteHost` are what make one-click remote control work without an operator typing anything. They are readable only by an authenticated admin of that specific organization.

---

### `POST /api/clients/remove`

Decommissions a workstation and revokes its device token. The machine's next heartbeat fails with `401` and it stops appearing on the dashboard.

```json
{ "clientId": "PC-01" }
```

→ `{ "status": "ok", "remaining": 14 }`

---

### `POST /api/auth/register`

Creates an organization and its first administrator. The organization starts `pending` and cannot enrol workstations until a super admin approves it.

```json
{
  "name": "Oakridge Holdings",
  "email": "principal@oakridge.edu",
  "password": "StrongPassword123!",
  "subdomain": "oakridge"
}
```

→ `{ "status": "ok", "message": "Organization registered successfully. Pending approval.", "subdomain": "oakridge" }`

Reserved slugs are refused. Passwords are checked by `validatePasswordStrength()` and stored as PBKDF2-HMAC-SHA256, 100 000 iterations, 32-byte random salt, 256 derived bits.

---

### `POST /api/auth/login`

```json
{ "email": "operator@oakridge.edu", "password": "StrongPassword123!" }
```

→ `{ "status": "ok", "role": "org_admin", "subdomain": "oakridge" }`, plus a `labkiosk_session` cookie.

Repeated failures back off exponentially per identifier, tracked in `login_attempts`.

---

### `POST /api/auth/change-password`

Rotates the password and revokes the account's **other** sessions, so a stolen cookie does not survive a password change. This is the only path by which a password changes.

```json
{ "currentPassword": "OldPassword123!", "newPassword": "NewStrongPassword456!" }
```

---

### `GET` / `POST` `/api/portal-sites`

`GET` is public and scoped to the host tenant; it is what the User Portal renders from. `POST` requires organization admin.

```json
{
  "title": "Scratch Programming",
  "url": "https://scratch.mit.edu",
  "category": "Computer Science",
  "icon": "🐱",
  "thumbnailUrl": "https://example.com/scratch.jpg"
}
```

Adding a card implicitly authorises its host: `buildEffectiveWhitelist()` unions the permanent allowlist with every portal app domain, so an operator never has to add a site in two places.

---

### `POST /api/settings/mode`

```json
{ "mode": "single_url", "defaultUrl": "https://canvas.example.edu" }
```

`safeHttpUrl()` prepends `https://` to a scheme-less domain, so `canvas.example.edu` is accepted.

---

### `POST /api/settings/customization`

```json
{
  "name": "Oakridge STEM Academy",
  "defaultLockMessage": "Examination active. No talking.",
  "portalTitle": "Digital Learning Lab",
  "portalSubtitle": "Select an approved page to begin",
  "portalDescription": "Computer Science Lab 304",
  "portalFooter": "For technical assistance, raise your hand."
}
```

Every one of these strings is attacker-controlled from the platform's perspective and is escaped on render. The test suite asserts that hostile input renders inert.

---

### `POST /api/settings/enrollment-key`

Rotates the key. Already-enrolled workstations keep their bearer tokens and are unaffected — rotation only prevents *new* enrolments with the old key.

→ `{ "status": "ok", "enrollmentKey": "KEY-WXYZ-7890-HIJK" }`

---

### Super admin endpoints

All take a `tenantId` and require a `super_admin` session.

```json
{ "tenantId": "tenant-uuid-1", "subdomain": "oakridge" }
```

Suspension is the platform's kill switch: a suspended organization's workstations receive `403` on telemetry, stop getting commands and policy, and its portal stops serving.

Custom domain approval binds an FQDN to a tenant. Once bound, Cloudflare routes it to the worker and `resolveTenant()` recognises it from the `Host` header. → [Super Admin Guide](Super-Admin-Guide)

---

## The client agent's loopback API

`agent.py` also serves a small HTTP API on **`127.0.0.1:8888`**, used only by the local setup wizard. It is not reachable from the network, from the organization LAN, or from a visited web page.

Every request must satisfy both `_is_expected_host()` (the `Host` header is loopback) and `_is_local_caller()` (the `Origin`, when present, is `127.0.0.1` or `localhost`). Either check failing returns `403`.

One further origin is accepted: the kiosk extension's own origin (`chrome-extension://hfjmbeplebjipenkfabncgkpadnjmmoe`, pinned by the `key` in `manifest.json`). Chromium stamps every non-`GET` fetch from the extension's service worker with it, and that worker is what the top bar's administrator modal uses to reach `POST /api/admin/verify`.

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/setup` | `GET` | Serves `wizard.html`. Returns `403` once the workstation is enrolled unless accessed via `#network` with admin authentication. |
| `/api/status` | `GET` | Local state: `clientId`, `clientNum`, `isLocked`, `lockMessage`, `targetUrl`, `broadcastUrl`, `broadcastEpoch`, `isConfigured`, `baseDomain`, `isLive`, `isInstalled`, `isOnline`, `persistentStorage`, `installRequested`. `persistentStorage` is false when `/etc/labkiosk` is not the `LABKIOSK_DATA` partition, i.e. an enrolment made now would not survive a reboot. |
| `/api/localization/options` | `GET` | Continents, countries, timezones, locales, keyboard layouts and interface catalogs, all read from the workstation's own tzdata, locale and X11 tables. |
| `/api/localization/languages` | `GET` | Interface languages the organization's control plane offers, with the installed ones marked. |
| `/api/localization/language/download` | `POST` | Downloads one catalog from the control plane into `/etc/labkiosk/i18n`. Administrator token required once installed. |
| `/api/localization/configure` | `POST` | Applies language, region, timezone, keyboard and (when `syncTime` is false) the clock by hand. Administrator token required once installed. |
| `/i18n/<tag>.json` | `GET` | An interface catalog. `en-US` is bundled; others come from `/etc/labkiosk/i18n`. |
| `/api/network/status` | `GET` | Comprehensive network status: active device, IPv4/IPv6 addresses, gateway, DNS, proxy, interfaces, and connectivity check. |
| `/api/network/interfaces` | `GET` | List of hardware interfaces with device name, type (`ethernet` / `wifi`), state, and physical carrier link status. |
| `/api/network/wifi/scan` | `GET` | Live Wi-Fi scan results: SSID, BSSID, signal strength (0-100), channel, security mode, and encrypted flag. |
| `/api/network/configure` | `POST` | Configures and connects interface (Ethernet/Wi-Fi) with IPv4/IPv6 mode (`auto`, `custom_dns`, `manual`), DNS, and optional HTTP proxy. |
| `/api/network/test` | `POST` | Probes DNS resolution and internet route reachability (`1.1.1.1:53` / `8.8.8.8:53`). |
| `/api/log` | `GET` | Tail of `/tmp/lab-agent.log` (max 64 KB, `text/plain`). Needs the `X-LabKiosk-Admin` token on an installed workstation. Shown by the wizard's **Agent Log & Diagnostics** panel. |
| `/api/admin/verify` | `POST` | Verifies administrator password against the GRUB PBKDF2 hash (`/etc/grub.d/01_labkiosk_password`) and returns a 10-minute token for `/api/network/configure` (header `X-LabKiosk-Admin`, required on installed systems). Throttled: 5 failures lock it for 60 s. |
| `/api/install/disks` | `GET` | Candidate target disks. Returns `[]` when not a live session. |
| `/api/install/status` | `GET` | Installation state and progress percentage. |
| `/api/install` | `POST` | Starts the disk install. `400` when the system is already installed. |
| `/api/reboot` | `POST` | Reboots the workstation. |
| `/api/setup` | `POST` | Performs enrolment against the control plane. `409` once already enrolled. |

`POST /api/install` takes `targetDisk` (re-validated against `TARGET_DISK_PATTERN`) and an optional `grubPasswordHash` (re-validated against `GRUB_PBKDF2_PATTERN`). Only a *digest* is accepted: the wizard derives PBKDF2 in the browser with WebCrypto, so the plaintext boot-menu password never crosses the agent's API, never appears in a process argument, and is never written to disk.

`POST /api/network/configure` manages NetworkManager connections. On installed machines, connection keyfiles are persisted in `LABKIOSK_DATA` (`/etc/labkiosk/system-connections/`) and bind-mounted to `/etc/NetworkManager/system-connections` via `/etc/fstab` so configurations persist across `overlayroot="tmpfs"` reboots.

→ [Client Agent](Client-Agent) · [Disk Installer](Disk-Installer)

---

## Known documentation drift

None currently tracked. `docs/API.md` was brought back in line with `ALLOWED_COMMANDS` in `src/index.ts` (`lock, unlock, navigate, reload, reboot, shutdown, clear-session, mute`); `ALLOWED_COMMANDS` and `CommandAction` in `src/types.ts` remain the authority.
