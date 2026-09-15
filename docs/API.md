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
