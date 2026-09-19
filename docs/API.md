# REST API Specification

[← Back to Documentation Hub](../README.md#documentation-hub)

A comprehensive technical reference for the Lab Kiosk Cloudflare Control Plane REST API, covering authentication contracts, tenant isolation, request schemas, and security controls.

---

## 🌟 Architecture & Security Contracts

### 1. Protocols & Content Types
- **Protocol:** HTTPS only in production (enforced via HSTS and edge redirection).
- **Format:** All requests and responses use `application/json; charset=utf-8` unless rendering HTML or redirecting.
- **Cache-Control:** All API responses specify `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

### 2. Authentication Schemes

| Scheme | Mechanism | Used By |
| :--- | :--- | :--- |
| **Session Cookie** | `Cookie: labkiosk_session=<hex32>` (`HttpOnly; Secure; SameSite=Lax`) | Web Consoles: Teacher Lab Dashboard, Super Admin Console |
| **Device Bearer Token** | `Authorization: Bearer <hex32>` | Workstation Client Agent (`agent.py`) for `/api/telemetry` |
| **Public / Key-Exchanged** | No auth or one-time verification (`enrollmentKey`) | Setup wizard, sign-in, signup, student portal sites, health probe |

### 3. Tenant Scoping & Resolution Rules
- The target school tenant is resolved authoritatively from the HTTP `Host` header via `resolveTenant()` in `src/guard.ts`.
- Subdomain format: `<school>.labkiosk.institution.edu` or an approved custom FQDN (e.g. `kiosk.institution.edu`).
- Query overrides (`?tenant=<subdomain>`) and `X-Tenant` headers are accepted **only** on local development hosts (`localhost`, `127.0.0.1`) or for requests carrying an active `super_admin` session.
- A caller attempting to act upon a tenant they do not administer is rejected with `403 Forbidden`.

### 4. Defense-in-Depth Security Controls
- **CSRF Origin Guard:** All cookie-authenticated mutations (`POST`, `DELETE`) pass `rejectCrossSiteMutation()`. Foreign cross-site `Origin` headers are rejected with `403 Forbidden`. Sign-out (`/api/auth/logout`) is POST-only.
- **Sign-In Rate Limiting:** Repeated failed sign-in attempts result in exponential back-off (`429 Too Many Requests`).
- **Enrolment Rate Limiting:** Failed device enrolment attempts from a given IP address are throttled after repeated invalid keys.
- **Payload Constraints:** Screen thumbnails are capped at 256 KB — the agent drops the
  `thumbnail` field entirely rather than send an oversized frame, so the heartbeat still lands.
  Workstation identifiers are matched against `CLIENT_ID_PATTERN`, and any URL the control plane
  returns is validated as `http(s)` by `safe_navigable_url()` before the agent stores it or the
  browser extension navigates to it.

---

## 📋 API Summary Matrix

| Endpoint | Method | Auth Scheme | Description |
| :--- | :--- | :--- | :--- |
| `/api/status` | `GET` | Public | System status and active kiosk target URL probe |
| `/api/auth/register` | `POST` | Public | Register school admin and claim subdomain |
| `/api/auth/login` | `POST` | Public | Sign in to Teacher Dashboard or Super Admin Console |
| `/api/auth/me` | `GET` | Session | Retrieve current authenticated user profile & tenant |
| `/api/auth/logout` | `POST` | Session | Invalidate session token and clear cookies |
| `/api/auth/change-password` | `POST` | Session | Rotate user password and revoke other active sessions |
| `/api/portal-sites` | `GET` | Public | List approved applications for student learning portal |
| `/api/portal-sites` | `POST` | Teacher Admin | Add a new application card to student portal |
| `/api/portal-sites/:id` | `DELETE` | Teacher Admin | Delete an application card from student portal |
| `/api/broadcast-presets` | `GET` | Teacher Admin | List quick-launch broadcast shortcuts |
| `/api/broadcast-presets` | `POST` | Teacher Admin | Add a custom broadcast shortcut |
| `/api/broadcast-presets/:id` | `DELETE` | Teacher Admin | Remove a broadcast shortcut |
| `/api/settings/mode` | `POST` | Teacher Admin | Toggle between `portal` launcher and `single_url` mode |
| `/api/settings/customization`| `GET` | Teacher Admin | Read custom branding and lock message configurations |
| `/api/settings/customization`| `POST` | Teacher Admin | Update custom branding, hero titles, and lock messages |
| `/api/settings/subdomain` | `POST` | Teacher Admin | Request change of school subdomain |
| `/api/settings/enrollment-key`| `GET` | Teacher Admin | View current workstation enrollment key |
| `/api/settings/enrollment-key`| `POST` | Teacher Admin | Regenerate/rotate workstation enrollment key |
| `/api/settings/custom-domain` | `POST` | Teacher Admin | Request custom domain binding (e.g. `kiosk.school.edu`) |
| `/api/settings/custom-domain` | `DELETE` | Teacher Admin | Disconnect custom domain binding |
| `/api/whitelist` | `GET` | Teacher Admin | List effective allowed domains for student workstations |
| `/api/whitelist` | `POST` | Teacher Admin | Add or remove a domain from the permanent allowlist |
| `/api/clients` | `GET` | Teacher Admin | List active workstation fleet with live thumbnails |
| `/api/clients/remove` | `POST` | Teacher Admin | Decommission workstation and revoke its device token |
| `/api/command` | `POST` | Teacher Admin | Dispatch remote command (lock, unlock, navigate, reload) |
| `/api/audit-logs` | `GET` | Teacher Admin | Retrieve paginated institutional security audit log |
| `/api/devices/enroll` | `POST` | Public / Key | Exchange school enrollment key for persistent device token |
| `/api/telemetry` | `POST` | Device Token | 3-second heartbeat, thumbnail ingest, command retrieval |
| `/api/super/tenants/approve` | `POST` | Super Admin | Approve pending school subdomain registration |
| `/api/super/tenants/reject` | `POST` | Super Admin | Reject pending school registration |
| `/api/super/tenants/suspend` | `POST` | Super Admin | Suspend active school tenant |
| `/api/super/tenants/reactivate`| `POST` | Super Admin | Reactivate suspended school tenant |
| `/api/super/tenants/custom-domain/approve`| `POST`| Super Admin | Approve and bind custom domain for a school |
| `/api/super/tenants/custom-domain/reject` | `POST`| Super Admin | Reject requested custom domain |
| `/api/super/tenants/custom-domain/remove` | `POST`| Super Admin | Remove assigned custom domain |

---

## 🔍 Detailed Endpoint Reference

### 1. System Health & Probes

#### `GET /api/status`
Returns the operational mode and current landing target. Used by the first-boot onboarding wizard.
- **Access:** Public
- **Response `200 OK`:**
  ```json
  {
    "status": "online",
    "enrolled": false,
    "mode": "portal",
    "targetUrl": "http://127.0.0.1:8888/setup"
  }
  ```

---

### 2. Authentication & Account Management

#### `POST /api/auth/register`
Creates a new school organization and initializes an administrator account.
- **Access:** Public (rate-limited per IP)
- **Request Body:**
  ```json
  {
    "name": "Oakridge High School",
    "email": "principal@oakridge.edu",
    "password": "StrongPassword123!",
    "subdomain": "oakridge"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "message": "School registered successfully. Pending approval.",
    "subdomain": "oakridge"
  }
  ```

#### `POST /api/auth/login`
Authenticates a teacher or platform super administrator.
- **Access:** Public (exponential back-off after repeated failures)
- **Request Body:**
  ```json
  {
    "email": "teacher@oakridge.edu",
    "password": "StrongPassword123!"
  }
  ```
- **Response `200 OK`:** Sets `labkiosk_session` cookie.
  ```json
  {
    "status": "ok",
    "role": "school_admin",
    "subdomain": "oakridge"
  }
  ```

#### `GET /api/auth/me`
Fetches profile details of the current signed-in user.
- **Access:** Session authenticated
- **Response `200 OK`:**
  ```json
  {
    "user": {
      "email": "teacher@oakridge.edu",
      "name": "Jane Doe",
      "role": "school_admin"
    },
    "tenant": {
      "id": "tenant-uuid",
      "name": "Oakridge High School",
      "subdomain": "oakridge",
      "mode": "portal"
    }
  }
  ```

#### `POST /api/auth/change-password`
Rotates password for the authenticated user and terminates all other concurrent sessions.
- **Access:** Session authenticated
- **Request Body:**
  ```json
  {
    "currentPassword": "OldPassword123!",
    "newPassword": "NewStrongPassword456!"
  }
  ```
- **Response `200 OK`:**
  ```json
  { "status": "ok" }
  ```

---

### 3. Student Learning Portal & Apps

#### `GET /api/portal-sites`
Fetches educational application cards displayed on the student launcher.
- **Access:** Public (scoped to host tenant)
- **Response `200 OK`:**
  ```json
  {
    "sites": [
      {
        "id": "site-uuid-1",
        "title": "Khan Academy",
        "url": "https://www.khanacademy.org",
        "category": "Math & Science",
        "icon": "🎓",
        "thumbnail_url": "https://images.unsplash.com/..."
      }
    ]
  }
  ```

#### `POST /api/portal-sites`
Adds a new application card to the student launcher.
- **Access:** School Admin
- **Request Body:**
  ```json
  {
    "title": "Scratch Programming",
    "url": "https://scratch.mit.edu",
    "category": "Computer Science",
    "icon": "🐱",
    "thumbnailUrl": "https://images.unsplash.com/photo-scratch"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "site": { "id": "generated-uuid", "title": "Scratch Programming", "url": "https://scratch.mit.edu" }
  }
  ```

---

### 4. Workstation Onboarding & Telemetry

#### `POST /api/devices/enroll`
Exchanges the school's enrollment key for a persistent workstation device token.
- **Access:** Public / Enrollment Key holder (throttled on failure)
- **Request Body:**
  ```json
  {
    "subdomain": "oakridge",
    "clientId": "PC-01",
    "enrollmentKey": "KEY-ABCD-1234-EFGH"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "deviceToken": "32_byte_hex_bearer_token",
    "clientId": "PC-01",
    "subdomain": "oakridge",
    "schoolName": "Oakridge High School",
    "mode": "portal",
    "targetUrl": "https://oakridge.labkiosk.institution.edu"
  }
  ```

#### `POST /api/telemetry`
Transmits 3-second heartbeat, active URL, screen screenshot thumbnail, and retrieves queued commands.
- **Access:** Workstation (`Authorization: Bearer <deviceToken>`)
- **Request Body:**
  ```json
  {
    "clientNum": 1,
    "activeUrl": "https://scratch.mit.edu",
    "isLocked": false,
    "thumbnail": "data:image/jpeg;base64,...",
    "vncPassword": "randomBootPassword12",
    "remoteHost": "pc-01.labkiosk.institution.edu"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "commands": [
      {
        "id": "cmd-123",
        "action": "lock",
        "message": "Eyes to the board please!"
      }
    ],
    "whitelist": ["scratch.mit.edu", "khanacademy.org", "oakridge.labkiosk.institution.edu"],
    "mode": "portal",
    "targetUrl": "https://oakridge.labkiosk.institution.edu",
    "broadcastUrl": "",
    "broadcastEpoch": 0
  }
  ```

---

### 5. Teacher Lab Console: Fleet & Commands

#### `GET /api/clients`
Retrieves all currently registered workstations and their latest telemetry state.
- **Access:** School Admin
- **Response `200 OK`:**
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
        "online": true,
        "vncPassword": "randomBootPassword12",
        "remoteHost": "pc-01.labkiosk.institution.edu"
      }
    }
  }
  ```

#### `POST /api/command`
Dispatches remote actions to one or all workstations.
- **Access:** School Admin
- **Supported Actions:** `lock`, `unlock`, `navigate`, `reload`, `poweroff`, `reboot`
- **Request Body Examples:**
  - **Freeze screens with custom message:**
    ```json
    {
      "target": "all",
      "action": "lock",
      "message": "Class attention! Midterm examination is beginning."
    }
    ```
  - **Broadcast website to all screens:**
    ```json
    {
      "target": "all",
      "action": "navigate",
      "url": "https://scratch.mit.edu"
    }
    ```
  - **Reset broadcast to student portal:**
    ```json
    {
      "target": "all",
      "action": "navigate",
      "resetPortal": true
    }
    ```
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "commandId": "cmd-uuid-99"
  }
  ```

#### `POST /api/clients/remove`
Decommissions a client device and revokes its bearer token.
- **Access:** School Admin
- **Request Body:**
  ```json
  { "clientId": "PC-01" }
  ```
- **Response `200 OK`:**
  ```json
  { "status": "ok", "remaining": 14 }
  ```

---

### 6. Settings & Customization

#### `POST /api/settings/mode`
Switches workstation launch behavior between the App Launcher Grid (`portal`) and Direct Single-Site Lockdown (`single_url`).
- **Access:** School Admin
- **Request Body:**
  ```json
  {
    "mode": "single_url",
    "defaultUrl": "https://canvas.institution.edu"
  }
  ```

#### `POST /api/settings/customization`
Configures school-specific branding, hero headers, and screen lock defaults.
- **Access:** School Admin
- **Request Body:**
  ```json
  {
    "name": "Oakridge STEM Academy",
    "defaultLockMessage": "Examination active. No talking.",
    "portalTitle": "Digital Learning Lab",
    "portalSubtitle": "Select an approved lesson to begin",
    "portalDescription": "Computer Science Lab 304",
    "portalFooter": "For technical assistance, raise your hand."
  }
  ```

#### `POST /api/settings/enrollment-key`
Rotates the school's workstation enrollment key. Existing workstations retain valid bearer tokens.
- **Access:** School Admin
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "enrollmentKey": "KEY-WXYZ-7890-HIJK"
  }
  ```

---

### 7. Super Administrator Console (`/super`)

#### `POST /api/super/tenants/approve`
Approves a pending school tenant registration.
- **Access:** Super Admin
- **Request Body:**
  ```json
  {
    "tenantId": "tenant-uuid-1",
    "subdomain": "oakridge"
  }
  ```

#### `POST /api/super/tenants/suspend`
Temporarily suspends an active school organization. Workstations for this tenant stop receiving telemetry and student portal access is blocked.
- **Access:** Super Admin
- **Request Body:**
  ```json
  { "tenantId": "tenant-uuid-1" }
  ```

#### `POST /api/super/tenants/custom-domain/approve`
Approves and activates a custom domain mapping for an institution.
- **Access:** Super Admin
- **Request Body:**
  ```json
  {
    "tenantId": "tenant-uuid-1",
    "customDomain": "kiosk.oakridge.edu"
  }
  ```

---

### 8. Client Agent Loopback API (`http://127.0.0.1:8888`)

Served locally on the workstation by `agent.py`. Binds strictly to `127.0.0.1` and enforces loopback Host/Origin validation (`_is_expected_host()` and `_is_local_caller()`). The only non-loopback `Origin` accepted is the kiosk extension's own origin (`chrome-extension://hfjmbeplebjipenkfabncgkpadnjmmoe`, pinned by the `key` in `manifest.json`), which Chromium puts on the extension service worker's `POST` to `/api/admin/verify`.

#### `GET /setup`
Serves `wizard.html` for network configuration and disk installation/enrolment. The page is served
on an enrolled workstation too, because it is where post-install network changes are made; the
fragment selects the mode:

| Fragment | Meaning |
| :--- | :--- |
| *(none)* | Normal setup flow. On an enrolled, installed workstation this is treated as `#network`. |
| `#network` | Network settings only. On an installed workstation the administrator modal opens first. |
| `#network&admin=<token>` | Same, already unlocked by the top-bar modal. The wizard keeps the token in memory and removes it from the address bar. |
| `#offline` | The extension redirected here after the workstation was offline for more than 6 s. The page returns to the lesson by itself once `/api/status` reports `isOnline` again. |

Enrolment is still refused once configured: `POST /api/setup` answers `409`.

#### `GET /api/status`
Returns the workstation's local runtime state. `isOnline` is true when any of these hold: a
heartbeat reached the control plane in the last 20 s, DNS resolves, a public resolver answers on
TCP 53, or the configured proxy accepts connections.

`persistentStorage` is false on an installed workstation whose `LABKIOSK_DATA` partition is not
mounted at `/etc/labkiosk`. Such a machine can still be enrolled, and loses the enrolment at the
next power-off, so the setup wizard shows a warning rather than a plain success. It is always true
on live media, which keeps nothing by design.
- **Response `200 OK`:**
  ```json
  {
    "clientId": "PC-01",
    "clientNum": 1,
    "isLocked": false,
    "lockMessage": "Screens locked by instructor",
    "targetUrl": "https://oakridge.labkiosk.institution.edu",
    "broadcastUrl": "",
    "broadcastEpoch": 0,
    "isConfigured": true,
    "baseDomain": "labkiosk.akbhoi.com",
    "isLive": false,
    "isInstalled": true,
    "isOnline": true,
    "persistentStorage": true,
    "installRequested": false
  }
  ```

#### `GET /api/network/status`
Returns complete network addressing, active route, DNS, and proxy status.
- **Response `200 OK`:**
  ```json
  {
    "online": true,
    "activeType": "wifi",
    "activeDevice": "wlan0",
    "activeConnection": "Kiosk-Wifi",
    "ipv4": {
      "address": "192.168.1.105/24",
      "gateway": "192.168.1.1",
      "dns": ["1.1.1.1", "1.0.0.1"]
    },
    "ipv6": {
      "address": "2001:db8::1/64",
      "gateway": "fe80::1",
      "dns": ["2606:4700:4700::1111"]
    },
    "proxy": {
      "enabled": false,
      "host": "",
      "port": 8080,
      "bypass": ""
    },
    "connectivity": {
      "ok": true,
      "dns": true,
      "internet": true,
      "proxy": null,
      "controlPlane": true,
      "details": "DNS resolution OK; Internet route reachable (1.1.1.1); Control plane reachable"
    },
    "interfaces": [],
    "adminRequired": true,
    "profile": {
      "name": "Kiosk-Ethernet",
      "type": "ethernet",
      "device": "ens3",
      "ssid": "",
      "hidden": false,
      "ipv4": { "mode": "manual", "address": "192.168.1.50/24", "gateway": "192.168.1.1", "dns": ["1.1.1.1"] },
      "ipv6": { "mode": "disabled", "address": "", "gateway": "", "dns": [] }
    }
  }
  ```
  `profile` is the saved NetworkManager profile, read back so the wizard can render the settings
  actually in force instead of its own defaults. `mode` is derived from the stored method:
  `manual`, `custom_dns` (automatic with `ignore-auto-dns`), `auto`, or `disabled`. It is `null`
  when the workstation has no kiosk profile yet.

#### `GET /api/network/interfaces`
Lists detected Ethernet and Wi-Fi adapters and link carrier status.
- **Response `200 OK`:**
  ```json
  [
    { "device": "eth0", "type": "ethernet", "state": "connected", "connection": "Kiosk-Ethernet", "carrier": true },
    { "device": "wlan0", "type": "wifi", "state": "disconnected", "connection": "", "carrier": false }
  ]
  ```

#### `GET /api/network/wifi/scan`
Returns nearby Wi-Fi SSIDs (strongest entry per SSID) sorted by signal strength. SSIDs are chosen by
whoever runs the access point, so clients must render every field as text.
- **Response `200 OK`:**
  ```json
  [
    { "ssid": "School-Students", "signal": 85, "bars": "▂▄▆█", "security": "WPA2", "inUse": false },
    { "ssid": "School-Guest", "signal": 60, "bars": "▂▄▆_", "security": "Open", "inUse": true }
  ]
  ```

#### `GET /api/log`
The tail of `/tmp/lab-agent.log` (at most 64 KB), as `text/plain`. A workstation has no terminal, no
getty, no SSH, and `file://` is blocked in its browser, so this is the only way to read the agent log
on real hardware. The setup wizard shows it under **Agent Log & Diagnostics**, and opens it by itself
when enrolment fails unexpectedly.

- **Authentication:** on an installed workstation the `X-LabKiosk-Admin` token from
  `POST /api/admin/verify` is required, exactly as for `/api/network/configure`. Live media needs
  none, because nothing is configured yet.
- **Response `200 OK`:** the log text, or an explanation when the file does not exist.
- **Note:** the log is in the RAM overlay and is gone at power-off. Read it before rebooting.

#### `POST /api/network/configure`
Validates the whole request, then replaces the `Kiosk-Ethernet` / `Kiosk-Wifi` NetworkManager
profile in one `nmcli connection add`, activates it and checks connectivity. Nothing is changed when
validation fails.
- **Authentication:** on an installed workstation, the `X-LabKiosk-Admin` header must carry a token
  from `POST /api/admin/verify`; otherwise `401`. Live media is setup mode and needs none.
- **Request Body:**
  ```json
  {
    "interfaceType": "wifi",
    "device": "",
    "ssid": "School-Students",
    "password": "SecretPassword123",
    "security": "WPA2",
    "hidden": false,
    "ipv4": { "mode": "custom_dns", "dns": ["1.1.1.1", "1.0.0.1"] },
    "ipv6": { "mode": "auto" },
    "proxy": {
      "enabled": true,
      "host": "proxy.school.internal",
      "port": 8080,
      "bypass": "*.school.internal, 10.0.0.0/8"
    }
  }
  ```
  - `ipv4.mode`: `auto`, `custom_dns` (needs `dns`), `manual` (needs `address` with a prefix, e.g.
    `192.168.1.50/24`; optional `gateway`, `dns`). `ipv6.mode` additionally accepts `disabled`.
  - `password` may be left empty for an SSID that already has a saved profile: the agent reuses the
    stored passphrase, so changing DNS or addressing does not require retyping the Wi-Fi key. The
    passphrase is never returned by the API.
  - `security` comes from the scan. `WPA3` without `WPA2` selects SAE; `802.1X` (WPA-Enterprise) is
    rejected. The passphrase is used exactly as typed (8–63 characters, or 64 hex digits).
  - `device` is optional and must name a detected adapter of that type.
  - The proxy is applied to the agent's own requests and to Chromium's `ProxySettings` policy;
    loopback is always exempt. A proxy change restarts the kiosk browser after the next heartbeat.
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "connection": "Kiosk-Wifi",
    "connectivity": { "ok": true, "dns": true, "internet": true, "proxy": true, "controlPlane": false, "details": "..." }
  }
  ```
- **Errors:** `400` invalid input, `401` missing/expired admin token, `500` NetworkManager refused
  the profile or it did not come up.

#### `POST /api/network/test`
Forces a fresh connectivity check. Same shape as `connectivity` above.

#### `POST /api/admin/verify`
Verifies the administrator (boot-menu) password against the PBKDF2 digest in
`/etc/grub.d/01_labkiosk_password` and issues a 10-minute token for `/api/network/configure`.
Attempts are serialised; after 5 failures the gate refuses all attempts for 60 s. When the
installation has no password file (installed without one, after a warning), any password is
accepted. A file that exists but cannot be parsed fails closed.
- **Request Body:**
  ```json
  { "password": "AdminPassword123" }
  ```
- **Response `200 OK`:**
  ```json
  { "verified": true, "token": "…", "expiresIn": 600 }
  ```
- **Response `401` / `429` / `500`:**
  ```json
  { "verified": false, "error": "Invalid administrator password" }
  ```

#### `POST /api/install`
Triggers automated disk installation to the specified target drive.
- **Request Body:**
  ```json
  {
    "targetDisk": "/dev/sda",
    "grubPasswordHash": "grub.pbkdf2.sha512.200000.abcd...1234..."
  }
  ```
- **Response `200 OK`:**
  ```json
  { "status": "started", "targetDisk": "/dev/sda" }
  ```
