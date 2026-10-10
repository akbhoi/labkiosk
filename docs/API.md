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
| **Session Cookie** | `Cookie: labkiosk_session=<hex32>` (`HttpOnly; Secure; SameSite=Lax`) | Web Consoles: Operator Lab Dashboard, Super Admin Console |
| **Device Bearer Token** | `Authorization: Bearer <hex32>` | Workstation Client Agent (`agent.py`) for `/api/telemetry` |
| **Public / Key-Exchanged** | No auth or one-time verification (`enrollmentKey`) | Setup wizard, sign-in, signup, user portal sites, health probe |

### 3. Tenant Scoping & Resolution Rules

- The target organization tenant is resolved authoritatively from the HTTP `Host` header via `resolveTenant()` in `src/guard.ts`.
- Subdomain format: `<organization>.labkiosk.example.com` or an approved custom FQDN (e.g. `kiosk.example.com`).
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
| `/api/auth/register/email-code` | `POST` | Public | `{"email"}`: email a six-digit code for registration (10 minutes; `409` when the address is registered) |
| `/api/auth/register` | `POST` | Public | Register an organization for review; nobody is signed in |
| `/api/contact/email-code` | `POST` | Public | `{ email, turnstileToken? }`: emails the six-digit code that proves the sender's address. Turnstile, when configured, is checked here |
| `/api/contact` | `POST` | Public | `{ name, organization?, email, emailCode, reason, message }`: the contact page's message. `reason` is `sales`, `support`, `billing`, `legal` or `general` and is the type it is filed under in Mail. Refused without the emailed code; the sender gets a receipt |
| `/api/auth/login` | `POST` | Public | Sign in to Admin console or Super Admin Console |
| `/api/auth/me` | `GET` | Session | Retrieve current authenticated user profile & tenant |
| `/api/auth/logout` | `POST` | Session | Invalidate session token and clear cookies |
| `/api/auth/change-password` | `POST` | Session | Rotate user password, revoke other active sessions and every trusted browser |
| `/api/auth/login` | `POST` | Public | `{"email", "password", "tenant"?}`: `{"status":"ok", "redirect"}` with the session cookie, or `{"status":"two_factor", "challenge", "method": "email"\|"app", "sentTo"}` when a second step is needed (always for a super admin; for an organization account that turned it on). With `method: "email"` the code has already been emailed |
| `/api/auth/login/verify` | `POST` | Public | `{"challenge", "code", "trustBrowser"?}`: the second step of a sign-in; `code` is the emailed code, the app's six digits or a recovery code |
| `/api/auth/login/email-code` | `POST` | Public | `{"challenge"}`: email a sign-in code to the account (three per sign-in, one a minute) |
| `/api/auth/two-factor` | `GET` | Session | `emailCodes` (an emailed code is asked for), `required` (it cannot be turned off: a super admin), `mailAvailable`, `enabled` (an authenticator app is on) and recovery codes left |
| `/api/auth/two-factor/email` | `POST` | Session | `{"password", "enabled"}`: turn the emailed sign-in code on or off for this account; `409` turning it off as a super admin, `503` turning it on where email is not configured |
| `/api/auth/two-factor/setup` | `POST` | Session | `{"password"}`: a new authenticator secret and `otpauth://` URI (not on until enabled) |
| `/api/auth/two-factor/enable` | `POST` | Session | `{"code"}`: turn it on; returns ten recovery codes once and signs other browsers out |
| `/api/auth/two-factor/recovery-codes` | `POST` | Session | `{"password", "code"}`: replace the recovery codes |
| `/api/auth/two-factor/disable` | `POST` | Session | `{"password", "code"}`: turn it off and forget trusted browsers |
| `/api/portal-sites` | `GET` | Public | List approved applications for user portal |
| `/api/portal-sites` | `POST` | Organization Admin | Add a new application card to user portal |
| `/api/portal-sites/:id` | `DELETE` | Organization Admin | Delete an application card from user portal |
| `/api/broadcast-presets` | `GET` | Organization Admin | List quick-launch broadcast shortcuts |
| `/api/broadcast-presets` | `POST` | Organization Admin | Add a custom broadcast shortcut |
| `/api/broadcast-presets/:id` | `DELETE` | Organization Admin | Remove a broadcast shortcut |
| `/api/settings/mode` | `POST` | Organization Admin | Toggle between `portal` launcher and `single_url` mode |
| `/api/settings/customization` | `GET` | Organization Admin | Read custom branding and lock message configurations |
| `/api/settings/customization` | `POST` | Organization Admin | Update custom branding, hero titles, and lock messages |
| `/api/settings/subdomain` | `POST` | Organization Admin | Request change of organization subdomain |
| `/api/settings/enrollment-key` | `GET` | Organization Admin | View current workstation enrollment key: 20 characters in four groups, the last being the Luhn (mod 30) check character of the rest. A key issued before the check character is replaced here |
| `/api/settings/enrollment-key` | `POST` | Organization Admin | Regenerate/rotate workstation enrollment key |
| `/api/settings/custom-domain` | `POST` | Organization Admin | Request custom domain binding (e.g. `kiosk.example.com`) |
| `/api/settings/custom-domain` | `DELETE` | Organization Admin | Disconnect custom domain binding |
| `/api/whitelist` | `GET` | Organization Admin | List effective allowed domains for user workstations |
| `/api/whitelist` | `POST` | Organization Admin | Add or remove a domain from the permanent allowlist |
| `/api/clients` | `GET` | Organization Admin | List active workstation fleet with live thumbnails |
| `/api/clients/remove` | `POST` | Organization Admin | Decommission workstation and revoke its device token |
| `/api/clients/group` | `POST` | Organization Admin | Assign multiple workstations to a named group |
| `/api/groups` | `GET` | Organization Admin | List workstation groups for the organization tenant |
| `/api/groups` | `POST` | Organization Admin | Create a new workstation group |
| `/api/groups/:id` | `DELETE` | Organization Admin | Delete a workstation group |
| `/api/tenant/staff` | `GET` | Organization Admin (`staff`) | List delegated operators, staff, and sub-admins |
| `/api/tenant/staff` | `POST` | Organization Admin (`staff`) | Create a staff account with role and permissions |
| `/api/tenant/staff/update` | `POST` | Organization Admin (`staff`) | Change a staff account's role or permissions |
| `/api/tenant/staff/:id` | `DELETE` | Organization Admin (`staff`) | Remove a staff account and end its sessions |
| `/api/command` | `POST` | Organization Admin | Dispatch remote command to targets (lock, unlock, reboot, shutdown, etc.) |
| `/api/audit-logs` | `GET` | Organization Admin | Retrieve paginated organization security audit log |
| `/api/devices/enroll` | `POST` | Public / Key | Exchange organization enrollment key for persistent device token |
| `/api/devices/ws` | `GET` (WebSocket) | Device Token | Control channel to the organization's OrgHub: configuration and commands pushed, status and watched frames up |
| `/api/telemetry` | `POST` | Device Token | HTTP fallback: 3-second heartbeat, thumbnail, command retrieval |
| `/api/devices/boot-report` | `POST` | Device Token | An installed workstation's boot outcome (update installed, failed, rolled back, error) |
| `/api/devices/update` | `GET` | Device Token | The system release this workstation's organization is offered and the folder to download it from, or `{"release": null}`; `503` when the platform has no https `RELEASES_BASE_URL` |
| `/api/settings/updates` | `GET`, `POST` | Organization Admin (`updates`) | The organization's update channel and the release it is offered; `POST {"channel": "stable"\|"beta"}` changes the channel |
| `/api/clients/check-update` | `POST` | Organization Admin (`updates`) | `{"clientIds"}`: ask these workstations to check for and download the offered release |
| `/api/clients/install-update` | `POST` | Organization Admin (`updates`) | `{"clientIds"}`: install the offered release on those that hold it downloaded and verified; `409` when nothing is offered |
| `/api/clients/remote-session` | `POST` | Organization Admin (`workstations`) | Open a Remote Control session through the console's relay: asks the workstation to join and returns the viewer's socket path |
| `/api/console/remote` | `GET` (WebSocket) | Organization Admin (`workstations`) | The viewer's side of a Remote Control session (VNC bytes) |
| `/api/devices/remote` | `GET` (WebSocket) | Device Token | The workstation's side of a Remote Control session (VNC bytes) |
| `/api/workstation-issues` | `GET` | Organization Admin (`settings`) | Errors and warnings workstations reported (Settings → Errors & Warnings), newest first, last 90 days, each with `report_state`, `report_match` (`new`/`existing`), `issue_url`, `issue_number`, `report_status` (`open`, `in_progress`, `pr_open`, `resolved`, `closed`) and `pr_url`; plus `bugReports: {enabled, available, repository, termsVersion, acceptedTermsVersion, termsAcceptedAt}` |
| `/api/settings/bug-reports` | `POST` | Organization Admin (`settings`) | `{"enabled": true, "acceptTerms": "<termsVersion>"}` or `{"enabled": false}`: opt in to or out of automatic, redacted GitHub bug reports; `400` without the current terms version, `409` when the platform has not set them up |
| `/terms/bug-reports` | `GET` | Public | The Automatic Bug Report Terms |
| `/api/console/ws` | `GET` (WebSocket) | Organization Admin (`workstations`) | The Workstations page's live channel: status changes and the frames of the screens it shows |
| `/api/tenant/remote-control/request` | `POST` | Organization Admin (`settings`) | `{"reason"}`: ask the platform to enable Remote Control; `409` when already asked or enabled |
| `/api/super/inbox` | `GET` | Super Admin | `?box=tasks\|support&filter=open\|closed\|all\|unread\|read\|deleted&mailbox=<address>&category=<type>`: registrations and Remote Control requests (Tasks) or mail (Mail), open first, oldest first. Mail lists also return `mailboxes` (`{mailbox, open, unread, total}`) and `mailDomain` |
| `/api/super/inbox/compose` | `POST` | Super Admin | `{"from", "to", "subject", "message", "format"?: "letter", "organization"?, "signatoryTitle"?}`: a new email (or a formal letter, tracking ID `LTR-…`) written as `from` (a name, or an address on the mail domain); `400` for another domain or a recipient on the platform's own domains, `502` when it was saved but not sent |
| `/api/super/inbox/:id` | `GET` | Super Admin | One conversation with its messages, organization and registration details; marks it read |
| `/api/super/inbox/:id/reply` | `POST` | Super Admin | `{"message", "close"?}`: email the contact; `502` when the mail was not sent |
| `/api/super/inbox/:id/note` | `POST` | Super Admin | `{"message"}`: an internal note, never emailed |
| `/api/super/inbox/:id/status` | `POST` | Super Admin | `{"status": "open"\|"closed"}`: mail conversations only |
| `/api/super/inbox/:id/unread` | `POST` | Super Admin | Mark the conversation unread again |
| `/api/super/inbox/:id/trash` | `POST` | Super Admin | Move a mail conversation to Deleted (nothing is removed); `400` for a task |
| `/api/super/inbox/:id/restore` | `POST` | Super Admin | Bring it back out of Deleted |
| `/api/super/inbox/:id/delete` | `POST` | Super Admin | Delete a conversation that is in Deleted, its messages and their stored originals, for good; `409` when it is not in Deleted, `400` for a task |
| `/api/super/inbox/:id/attachment/:messageId/:index` | `GET` | Super Admin | One attachment of an incoming message (`:index` from its `attachments` list), or `original` for the whole `.eml`; always `application/octet-stream` as a download |
| `/api/super/inbox/:id/verify-phone` | `POST` | Super Admin | Record that a registration's phone number was confirmed |
| `/api/super/inbox/:id/approve` | `POST` | Super Admin | `{"message"?}`: activate the organization (needs a confirmed phone) or enable Remote Control, and email the contact |
| `/api/super/inbox/:id/reject` | `POST` | Super Admin | `{"message"?}`: decline the registration or Remote Control request, and email the contact |
| `/api/super/tenants/approve` | `POST` | Super Admin | Approve an organization's requested subdomain change |
| `/api/super/tenants/reject` | `POST` | Super Admin | Decline an organization's requested subdomain change |
| `/api/super/tenants/suspend` | `POST` | Super Admin | Suspend active organization tenant |
| `/api/super/tenants/reactivate` | `POST` | Super Admin | Reactivate suspended organization tenant |
| `/api/super/tenants/custom-domain/approve` | `POST` | Super Admin | Approve and bind custom domain for an organization |
| `/api/super/tenants/custom-domain/reject` | `POST` | Super Admin | Reject requested custom domain |
| `/api/super/tenants/custom-domain/remove` | `POST` | Super Admin | Remove assigned custom domain |
| `/api/super/releases` | `GET` | Super Admin | Record new releases found in the `RELEASES` bucket and list them all; `503` without the binding |
| `/api/super/releases/classify` | `POST` | Super Admin | `{"version", "channel": "beta"\|"stable"\|null}`: offer a release on a channel, or withdraw it (`null`) |
| `/api/super/releases/revoke` | `POST` | Super Admin | `{"version"}`: withdraw a release for good; `409` when already revoked |

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

Registers an organization for review. Ask for `emailCode` first with
`POST /api/auth/register/email-code`. Every field below is required except `legalName`,
`organizationType`, `addressLine2`, `region`, `taxId`, `billingEmail`, `workstationEstimate` and
`notes`. The phone number is international (`+` and the country code). The organization is
`pending`, nobody is signed in, and the contact is emailed; a super admin confirms the phone and
approves it under Super Admin → Tasks, which emails the console address.

- **Access:** Public (rate-limited per address and per email)
- **Request Body:**

  ```json
  {
    "name": "Oakridge Holdings",
    "legalName": "Oakridge Holdings Pvt Ltd",
    "organizationType": "business",
    "contactName": "Jane Smith",
    "email": "it@oakridge.example",
    "emailCode": "482913",
    "phone": "+91 98765 43210",
    "password": "StrongPassword123!",
    "subdomain": "oakridge",
    "addressLine1": "12 Market Road",
    "city": "Bhubaneswar",
    "region": "Odisha",
    "postalCode": "751001",
    "country": "India",
    "taxId": "21ABCDE1234F1Z5",
    "billingEmail": "accounts@oakridge.example",
    "workstationEstimate": 40,
    "acceptTerms": true
  }
  ```

- **Response `200 OK`:** `{ "status": "ok", "pending": true, "reference": "LK-7Q2M4K" }`

#### `POST /api/auth/login`

Authenticates an operator or platform super administrator.

- **Access:** Public (exponential back-off after repeated failures)
- **Request Body:**

  ```json
  {
    "email": "operator@oakridge.edu",
    "password": "StrongPassword123!"
  }
  ```

- **Response `200 OK`:** Sets the `labkiosk_session` cookie and the `labkiosk_device` cookie
  (`Path=/api/auth`, the browser's identity for sign-in alerts and "trust this browser").

  ```json
  {
    "status": "ok",
    "role": "org_admin",
    "subdomain": "oakridge",
    "redirect": "https://oakridge.labkiosk.org/admin"
  }
  ```

- **Two-factor sign-in:** when the account has it on and the browser is not trusted, no cookie is
  set and the answer is `{ "status": "two_factor", "challenge": "<64 hex>", "expiresIn": 600 }`.
  `POST /api/auth/login/verify` with the challenge and a code completes it (five wrong codes end the
  challenge); `POST /api/auth/login/email-code` sends a code by email instead.
- **New-browser alert:** a successful sign-in from a browser the account has not used before is
  reported to the account's email address (the first browser an account ever uses is not).

#### `GET /api/auth/me`

Fetches profile details of the current signed-in user.

- **Access:** Session authenticated
- **Response `200 OK`:**

  ```json
  {
    "user": {
      "email": "operator@oakridge.edu",
      "name": "Jane Doe",
      "role": "org_admin"
    },
    "tenant": {
      "id": "tenant-uuid",
      "name": "Oakridge Holdings",
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

### 3. User Portal & Apps

#### `GET /api/portal-sites`

Fetches approved application cards displayed on the user launcher.

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

Adds a new application card to the user launcher.

- **Access:** Organization Admin
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

Exchanges the organization's enrollment key for a persistent workstation device token.

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
    "organizationName": "Oakridge Holdings",
    "schoolName": "Oakridge Holdings",
    "mode": "portal",
    "targetUrl": "https://oakridge.labkiosk.example.com"
  }
  ```

`schoolName` is also sent, with the same value, for agents installed from an ISO older than the
organization vocabulary. It is deprecated: new code reads `organizationName`, and the field will be
removed once no workstation in the field depends on it.

#### `GET /api/devices/ws`

The workstation's control channel: a WebSocket to its organization's OrgHub Durable Object.

- **Access:** Workstation (`Authorization: Bearer <deviceToken>` on the upgrade). `401`/`403` when the
  token or the organization is refused; `426` without `Upgrade: websocket`.
- **Hub → workstation:**
  - `{"type":"config","whitelist":[…],"mode":"portal","targetUrl":"…","broadcastUrl":"","broadcastEpoch":0,"commands":[…]}`
    on connect and after every admin change;
  - `{"type":"commands","commands":[{"id":"…","action":"lock","message":"…"}]}` when dispatched.
    Besides the [`POST /api/command`](#post-apicommand) actions, the hub sends
    `{"action":"release-available","version":"…"}` (download the release meant for this
    workstation, a security release for its own line before the newest one; see
    [`GET /api/devices/update`](#get-apidevicesupdate)) and `{"action":"install-update","version":"…"}`
    (install the release this workstation holds `ready`; queued only by
    [`POST /api/clients/install-update`](#post-apiclientscheck-update-post-apiclientsinstall-update));
  - `{"type":"frames","on":true,"intervalSeconds":3}` while a console shows this screen, `on:false` after;
  - `{"type":"pong"}`, answered at the edge.
- **Workstation → hub:**
  - `{"type":"status","clientNum":1,"activeUrl":"…","isLocked":false,"vncPassword":"…"}`
    on connect and whenever it changes. An agent from 2.9.0 on adds `imageVersion`, `agentVersion`
    and `update: {"phase", "version"?, "progress"?, "detail"?, "kind"?, "since"?}`, `phase` being
    `live`, `idle`, `checking`, `downloading`, `ready`, `staged` (a security release that installs
    at the next start), `installing`, `up-to-date` or `error`; `kind` (`feature` or `security`)
    and `since` (unix seconds) come with `ready` and `staged` (the HTTP fallback body carries the
    same fields);
  - `{"type":"frame","thumbnail":"data:image/jpeg;base64,…"}` every `intervalSeconds` while asked
    (≤ 256 KB, relayed to consoles and never stored);
  - `{"type":"ping"}` every 15 s, exactly these bytes.
- **Close codes:** `4001` workstation removed, `4003` organization not active, `4000` replaced by a
  newer connection, `4008` nothing received for 75 s.

#### `GET /api/console/ws`

The live channel of the Workstations page. **Access:** a session with the `workstations`
permission, and an `Origin` of this site (a WebSocket from another site, or without `Origin`, is
refused with `403`). The console sends `{"type":"watch","clientIds":[…]}` for the screens it is
showing and receives `snapshot`, `status`, `frame` and `removed` messages. Without it, the page
polls `POST /api/clients` with the same `watch` list.

#### `POST /api/telemetry`

The HTTP fallback, used by agents without the WebSocket client: a 3-second heartbeat carrying the
active URL, a screen thumbnail and the remote-control details, answered with the configuration and
any queued commands.

- **Access:** Workstation (`Authorization: Bearer <deviceToken>`)
- **Request Body:**

  ```json
  {
    "clientNum": 1,
    "activeUrl": "https://scratch.mit.edu",
    "isLocked": false,
    "thumbnail": "data:image/jpeg;base64,...",
    "vncPassword": "randomBootPassword12"
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
    "whitelist": ["scratch.mit.edu", "khanacademy.org", "oakridge.labkiosk.example.com"],
    "mode": "portal",
    "targetUrl": "https://oakridge.labkiosk.example.com",
    "broadcastUrl": "",
    "broadcastEpoch": 0
  }
  ```

#### Remote Control through the console: `POST /api/clients/remote-session`, `GET /api/console/remote`, `GET /api/devices/remote`

The console reaches a workstation's VNC server through its own address, with no tunnel, DNS record or
route per workstation. Each open session is one `RemoteRelay` Durable Object (`src/remote_relay.ts`)
named after the organization and workstation, which pairs two WebSockets and forwards their binary
messages to each other.

1. The viewer (`GET /console/remote?clientId=PC-01`, `workstations` permission) posts
   `{"clientId": "PC-01"}` to `/api/clients/remote-session`. The Worker makes a random 32-byte
   session token, stores only its SHA-256 in the relay with the operator's user id, and asks the
   organization's hub to send `{"type": "remote", "session": "<token>"}` over the workstation's
   control channel. **Responses:** `200 {"socketPath": "/api/console/remote?clientId=…&session=…",
   "joinSeconds": 60}`; `400` for a bad workstation id; `409` when the workstation is not connected
   to the hub; `502` when the relay or hub fails; `503` without the `REMOTE_RELAY` binding. Each
   session is written to the audit log (`device.remote_control`, `via: relay`).
2. The viewer opens `socketPath` (same cookie and `workstations` permission, and the cross-site
   socket check of `/api/console/ws`). The agent opens `/api/devices/remote` with its device bearer
   token and the token in `X-Labkiosk-Session`, then connects to its own `127.0.0.1:5900`.
3. Both must join within 60 seconds, each side at most once, and the console side only as the
   operator who opened it (`403` otherwise, `410` once expired, `409` for a side already present).
   The relay sends the agent `{"type": "ready"}` once the viewer is there; from then on binary
   messages are VNC bytes. A text `{"type": "ping"}` is answered `{"type": "pong"}` by the relay
   itself; other text is dropped.
4. Either side closing closes the other (`4004`). A new session for the same workstation closes the
   old one (`4000`), and a session ends after four hours (`4008`).

The VNC password still travels in the viewer's address fragment, which browsers never send, and the
viewer removes it before it connects. noVNC is served from `/novnc/` (Workers static assets, staged
from the pinned `@novnc/novnc` package).

#### `POST /api/devices/boot-report`

What an installed workstation's last boot did with its system image, as `labkiosk-boot-slots
check` recorded it in `/run/labkiosk-update/status.json`. The agent sends only the outcomes worth
an administrator's attention; each new one is kept on the workstation (`client_devices.update_*`).
A failure, rollback, fallback or error is also listed in `workstation_issues` (Settings → Errors &
Warnings, `GET /api/workstation-issues`) as `update_failed`, `update_rolled_back`, `boot_error`
(severity `error`) or `boot_fallback` (`warning`). None of it goes to the audit log, which records
what people did.

- **Access:** Workstation (`Authorization: Bearer <deviceToken>`); the token decides the
  organization and the workstation.
- **Request Body:** `state` (`installed` | `failed` | `rolled-back` | `fallback` | `error`),
  `version` (the image running), `at` (when the workstation recorded it, Unix seconds, within the
  last 7 days); optional `previous`, `failed` (release versions) and `error` (text, cut to 300
  characters).

  ```json
  { "state": "rolled-back", "version": "2.5.1", "failed": "2.6.0", "at": 1791100000 }
  ```

- **Responses:** `200 {"status":"ok","recorded":true}`; `recorded: false` for a report the
  workstation already sent (or one less than 60 s after the last); `400` malformed, not sent again;
  `409` the workstation has not checked in yet, sent again later.

#### `GET /api/devices/update`

The system release this workstation's organization is offered, asked by the workstation's root
updater (`labkiosk-update run`) when the hub sends `release-available`. `release` is the newest
unrevoked release classified `stable`, and also `beta` ones when the organization's update channel
is `beta`. `security` is the newest `security` release of that set for the line (major.minor) of
`running`, the image the workstation runs, when it is newer; `securityUpdates` says whether the
workstation installs it at its next start by itself (`next_boot`) or waits for an administrator
(`approval`). Files are downloaded from `url` (`RELEASES_BASE_URL` + `releases/<version>`), not
through the Worker; the workstation checks the manifest's signature before it uses any of them, and
stages a release for its next start only when the signed manifest says `security`.

- **Access:** Workstation (`Authorization: Bearer <deviceToken>`); the token decides the
  organization. `403` when the organization is not active.
- **Query:** `running` — the workstation's image version, such as `2.9.0`. Optional: without it
  (a 2.9.0 updater) `security` is `null`.
- **Response `200 OK`** (`GET /api/devices/update?running=2.9.0`):

  ```json
  {
    "release": { "version": "2.10.0", "kind": "feature", "sizeBytes": 735000000, "url": "https://releases.example.com/releases/2.10.0" },
    "security": { "version": "2.9.1", "kind": "security", "sizeBytes": 734000000, "url": "https://releases.example.com/releases/2.9.1" },
    "securityUpdates": "next_boot"
  }
  ```

  `release` and `security` are `null` when nothing is offered.
- **Errors:** `400` when `running` is not a release version; `503` when a release is offered but
  `RELEASES_BASE_URL` is unset or not an https address, so a workstation never takes a missing
  setting for "up to date".

---

### 5. Operator Lab Console: Fleet & Commands

#### `GET /api/clients`

Retrieves all registered workstations: the D1 registry merged with the organization hub's live
status. `POST /api/clients` with `{"watch":["PC-01"]}` does the same and asks the hub for those
screens' frames for the next 10 seconds.

- **Access:** Organization Admin
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
        "imageVersion": "2.9.0",
        "agentVersion": "2.9.0",
        "update": { "phase": "ready", "version": "2.9.1" }
      }
    }
  }
  ```

#### `POST /api/command`

Dispatches remote actions to one, selected subsets, or all workstations.

- **Access:** Organization Admin. `navigate` requires the `broadcast` permission; every other action requires `workstations`.
- **Supported Actions:** `lock`, `unlock`, `navigate`, `reload`, `reboot`, `shutdown`, `clear-session`, `mute`. Anything else answers `400`,
  including `release-available` and `install-update`, which only the update routes below queue.
- **`clear-session`** signs users out at the end of a period without a reboot: the workstation ends its
  browser, and the kiosk watchdog deletes the Chromium profile (cookies, saved sign-ins, history, local
  storage, IndexedDB, service workers) and disk cache before relaunching on the workstation's assigned page.
- **Targeting:** Specify either `targets: string[]` (array of client IDs, e.g. `["PC-01", "PC-02"]`) or single `target: string` (`"all"` or `"PC-01"`).
  Duplicates are removed, `"all"` replaces any named targets rather than queueing a second command for each,
  and at most **500** targets are accepted per request (`400` otherwise).
- **Broadcasts stick.** A `navigate` (or `resetPortal`) is recorded where it was addressed: `"all"`
  organization-wide, a list of ids on each of those workstations. Every heartbeat answers with the newer of
  the two as `targetUrl` / `broadcastUrl` / `broadcastEpoch`, so a broadcast to selected screens is not
  undone by the next heartbeat, and a reset of some screens does not stop the others' broadcast.
- **`message`** (optional, `lock` only): shown on the lock curtain, truncated to 280 characters. Without it the
  organization's default lock message is used.
- **Request Body Examples:**
  - **Batch lock selected workstations with custom message:**

    ```json
    {
      "targets": ["PC-01", "PC-02", "PC-05"],
      "action": "lock",
      "message": "Class attention! Midterm examination is beginning."
    }
    ```

  - **Reboot or shutdown specific machines:**

    ```json
    {
      "targets": ["PC-03"],
      "action": "shutdown"
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

  - **Reset broadcast to user portal** (there is no `reset` action; it is `navigate` with `resetPortal`):

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
    "commandId": "cmd-uuid-99",
    "commandIds": ["cmd-uuid-99", "cmd-uuid-100"],
    "count": 2
  }
  ```

#### `GET /api/groups`

Retrieves all defined workstation groups for the organization tenant.

- **Access:** Organization Admin (requires `workstations` permission)
- **Response `200 OK`:**

  ```json
  {
    "groups": [
      { "id": "8f0c…", "tenant_id": "…", "name": "Lab A", "created_at": 1726300100 },
      { "id": "1b2d…", "tenant_id": "…", "name": "Row 1", "created_at": 1726300000 }
    ]
  }
  ```

#### `POST /api/groups`

Creates a new named workstation group.

- **Access:** Organization Admin (requires `workstations` permission)
- **Request Body:** `{ "name": "Robotics Bay" }` — 1 to 50 characters.
- **Response `200 OK`:** `{ "status": "ok", "group": { "id": "…", "tenant_id": "…", "name": "Robotics Bay", "created_at": 1726300200 } }`
- **Errors:** `400` empty or over-long name; `409` a group with that name already exists (compared
  case-insensitively — membership is stored by name, so two groups sharing one would share members).

#### `DELETE /api/groups/:id`

Deletes a workstation group and resets member devices' `group_name` to `NULL`.

- **Access:** Organization Admin (requires `workstations` permission)
- **Response `200 OK`:** `{ "status": "ok" }`; `404` when the group does not exist in this organization.

#### `POST /api/clients/group`

Assigns multiple workstations to a designated group (or unassigns if `groupName` is empty or `null`).

- **Access:** Organization Admin (requires `workstations` permission)
- **Request Body:**

  ```json
  {
    "clientIds": ["PC-01", "PC-02"],
    "groupName": "Row 1"
  }
  ```

- **Response `200 OK`:** `{ "status": "ok", "count": 2 }`
- **Errors:** `404` when `groupName` is not an existing group; `400` for more than 500 ids.

#### `POST /api/clients/remove`

Decommissions a client device and revokes its bearer token.

- **Access:** Organization Admin
- **Request Body:**

  ```json
  { "clientId": "PC-01" }
  ```

- **Response `200 OK`:**

  ```json
  { "status": "ok", "remaining": 14 }
  ```

#### `POST /api/clients/check-update`, `POST /api/clients/install-update`

The Workstations page's **Updates** menu. `check-update` sends `release-available` to each
workstation, which then asks [`GET /api/devices/update`](#get-apidevicesupdate) and downloads the
offered release in the background. `install-update` sends `install-update` only to workstations
that are online and report `ready` for the release meant for them (a security release for their
line before the newest one); each one restarts into it, and the rest are returned in `skipped`
with the reason (`Offline`, `Still downloading`, `Live session; update it by re-flashing`,
`Already up to date`, `Installs at its next restart; restart it to install now`, …) and are never
updated later on their own. Audited as `update.check` and `update.install`.

- **Access:** Organization Admin (requires `updates` permission)
- **Request Body:** `{ "clientIds": ["PC-01", "PC-02"] }` — at most 500. An id that is not a
  workstation of this organization is returned in `skipped` with the reason `Not found`.
- **Response `200 OK`:**

  ```json
  {
    "status": "ok",
    "version": "2.9.1",
    "versions": ["2.9.1"],
    "sent": ["PC-01"],
    "skipped": [{ "clientId": "PC-02", "reason": "Still downloading" }]
  }
  ```

  `version` is the newest offered release, `null` when nothing is offered (`check-update` only);
  a workstation holding a security release for its line installs that one. `versions`
  (`install-update` only) lists the versions sent.
- **Errors:** `400` without ids or with more than 500; `409` (`install-update`) when no release
  is offered to this organization.

---

### 5b. Staff Delegation

**Roles:** `org_admin` (Co-Administrator, full access), `sub_admin`, `operator`, `assistant`,
`content_manager`. **Permissions:** `workstations`, `broadcast`, `portal`, `whitelist`, `staff`,
`settings`, `updates` (system updates). The Apps & Web page opens with any of `broadcast`, `portal` or `whitelist`, and each of its
three tabs calls routes guarded by that one permission. `*` is never stored; full access comes from
owning the organization or holding the `org_admin` role.

**Delegation limits.** A staff member who holds `staff` but is not a co-administrator may only grant
permissions they hold themselves, may not appoint an `org_admin`, and may not change or remove their
own account or a co-administrator's. Each of those answers `403`. Without these limits the staff
permission was a path to full control of the organization.

#### `GET /api/tenant/staff`

Lists all authorized operators, assistants, and sub-administrators delegated for this organization tenant.

- **Access:** Organization Admin (requires `staff` permission — the list carries every colleague's email)
- **Response `200 OK`:**

  ```json
  {
    "status": "ok",
    "staff": [
      {
        "id": "5c1e…",
        "tenant_id": "…",
        "user_id": "…",
        "email": "sarah.smith@greenwood.example",
        "name": "Sarah Smith",
        "role": "operator",
        "permissions": ["workstations", "broadcast"],
        "created_at": 1726300000
      }
    ]
  }
  ```

#### `POST /api/tenant/staff`

Creates a delegated staff account with a role and granular permissions.

- **Access:** Organization Admin (requires `staff` permission, within the delegation limits above)
- **Request Body:**

  ```json
  {
    "email": "john.doe@greenwood.example",
    "password": "SecurePassword123!",
    "name": "John Doe",
    "role": "operator",
    "permissions": ["workstations", "broadcast"]
  }
  ```

- **Response `200 OK`:** `{ "status": "ok", "operator": { "id": "…", "role": "operator", "permissions": [...], ... } }`
- **Errors:** `400` unknown role or permission, or a password under 12 characters or without both letters
  and digits; `409` the email already belongs to an account (it is never linked into another organization).

#### `POST /api/tenant/staff/update`

Changes a staff account's role and/or permissions. Omitted fields are left as they are.

- **Access:** Organization Admin (requires `staff` permission, within the delegation limits above)
- **Request Body:** `{ "id": "5c1e…", "role": "assistant", "permissions": ["workstations"] }`
- **Response `200 OK`:** `{ "status": "ok" }`; `404` when the id is not a staff account of this organization.

#### `DELETE /api/tenant/staff/:id`

Removes a staff account from the organization and ends every session it holds.

- **Access:** Organization Admin (requires `staff` permission, within the delegation limits above)
- **Response `200 OK`:** `{ "status": "ok" }`; `404` when the id is not a staff account of this organization.

---

### 6. Settings & Customization

#### `POST /api/settings/mode`

Switches workstation launch behavior between the App Launcher Grid (`portal`) and Direct Single-Site Lockdown (`single_url`).

- **Access:** Organization Admin
- **Request Body:**

  ```json
  {
    "mode": "single_url",
    "defaultUrl": "https://canvas.example.com"
  }
  ```

#### `POST /api/settings/customization`

Configures organization-specific branding, hero headers, and screen lock defaults.

- **Access:** Organization Admin
- **Request Body:**

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

#### `POST /api/settings/enrollment-key`

Rotates the organization's workstation enrollment key. Existing workstations retain valid bearer tokens.

- **Access:** Organization Admin
- **Response `200 OK`:**

  ```json
  {
    "status": "ok",
    "enrollmentKey": "KEY-WXYZ-7890-HIJK"
  }
  ```

#### Errors & Warnings: `GET /api/workstation-issues`, `POST /api/settings/bug-reports`

The **Errors & Warnings** sub-tab of Settings lists what workstations reported about themselves
(failed or rolled-back updates and boot errors, from
[`POST /api/devices/boot-report`](#post-apidevicesboot-report)), kept for 90 days and separate from
the audit log. `GET /api/workstation-issues` returns the list and the organization's automatic bug
report setting (fields in the [summary matrix](#-api-summary-matrix)). `POST
/api/settings/bug-reports` turns automatic, redacted GitHub bug reports on or off; turning them on
must name the current terms version (`/terms/bug-reports`), and the change is written to the
audit log.

- **Access:** Organization Admin (requires `settings` permission)
- **Request Body:** `{ "enabled": true, "acceptTerms": "2026-10-04" }` or `{ "enabled": false }`
- **Response `200 OK`:** `{ "status": "ok", "enabled": true }`; `400` when `enabled` is not a
  boolean or the terms version is not the current one; `409` when the platform has not set up bug
  reports.

#### `GET /api/settings/updates`, `POST /api/settings/updates`

The **Updates** tab of Settings: which classified releases the organization's workstations are
offered, and what they do with a security release for the line they run. `stable` (the default)
offers stable releases; `beta` also offers beta ones. `securityUpdates` is `next_boot` (the
default: installed at each workstation's next start, without approval) or `approval`. Changes are
audited as `settings.update_channel` and `settings.security_updates`, and the organization's hub
tells its workstations at once.

- **Access:** Organization Admin (requires `updates` permission)
- **Request Body (`POST`):** `{ "channel": "beta", "securityUpdates": "approval" }` — either or both.
- **Response `200 OK`:**

  ```json
  {
    "channel": "beta",
    "offer": { "version": "2.10.0", "kind": "feature", "sizeBytes": 735000000, "classifiedAt": 1791638060 },
    "securityUpdates": "next_boot",
    "pending": [{ "version": "2.9.1", "offeredAt": 1791638060, "workstations": 3 }]
  }
  ```

  `offer` is `null` when nothing is offered on that channel. `pending` lists, per line, the newest
  security release that some of the organization's workstations on that line do not run yet.
- **Errors:** `400` for any other channel or setting, or a body with neither.

---

### 7. Super Administrator Console (`/super`)

Registrations and Remote Control requests are decided under **Tasks** (`/api/super/inbox`, above).

#### `POST /api/super/tenants/approve`

Approves an organization's requested subdomain change.

- **Access:** Super Admin
- **Request Body:**

  ```json
  {
    "tenantId": "tenant-uuid-1",
    "subdomain": "oakridge"
  }
  ```

#### `POST /api/super/tenants/suspend`

Temporarily suspends an active organization. Workstations for this tenant stop receiving telemetry and user portal access is blocked.

- **Access:** Super Admin
- **Request Body:**

  ```json
  { "tenantId": "tenant-uuid-1" }
  ```

#### `POST /api/super/tenants/custom-domain/approve`

Approves and activates a custom domain mapping for an organization.

- **Access:** Super Admin
- **Request Body:**

  ```json
  {
    "tenantId": "tenant-uuid-1",
    "customDomain": "kiosk.oakridge.edu"
  }
  ```

#### Releases: `GET /api/super/releases`, `POST /api/super/releases/classify`, `POST /api/super/releases/revoke`

The **Releases** tab (`/super/releases`). CI uploads each signed release to the `RELEASES` R2
bucket under `releases/<version>/`. `GET` first records every new folder whose `manifest.json`
parses, names that folder's version and has `manifest.json.sig` beside it, then lists all
releases, newest version first. A recorded release reaches no workstation until it is classified.
`classify` puts it on `beta` or `stable`, or takes it off (`null`, **Withdraw**); `revoke`
withdraws it for good. Either change is audited (`release.classify`, `release.revoke`) and every
organization with workstations online reloads its offer.

- **Access:** Super Admin
- **Request Body:** `{ "version": "2.9.1", "channel": "stable" }` (classify) or
  `{ "version": "2.9.1" }` (revoke).
- **Response `200 OK` (`GET`):**

  ```json
  {
    "releases": [
      { "version": "2.9.1", "channel": null, "kind": "feature", "baseVersion": null, "securityFloor": "2.9.0",
        "sizeBytes": 735000000, "builtAt": "2026-10-09T12:00:00Z", "foundAt": 1791500000,
        "classifiedAt": null, "revokedAt": null }
    ],
    "added": ["2.9.1"],
    "problems": [{ "version": "2.9.2", "problem": "manifest.json.sig is missing" }],
    "downloadsConfigured": true
  }
  ```

  `downloadsConfigured` is false while `RELEASES_BASE_URL` is unset or not https. `classify` and
  `revoke` answer `{ "status": "ok", "releases": [...] }`.
- **Errors:** `503` (`GET`) without the `RELEASES` binding; `400` invalid version or channel;
  `404` unknown release; `409` the release is already revoked.

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
| `#offline` | The extension redirected here after the workstation was offline for more than 6 s. The page returns to the page by itself once `/api/status` reports `isOnline` again. |

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
    "lockMessage": "Screens locked by operator",
    "targetUrl": "https://oakridge.labkiosk.example.com",
    "broadcastUrl": "",
    "broadcastEpoch": 0,
    "isConfigured": true,
    "baseDomain": "labkiosk.org",
    "isLive": false,
    "isInstalled": true,
    "isOnline": true,
    "persistentStorage": true,
    "installRequested": false
  }
  ```

#### `GET /api/localization/options`

Everything the Language & Region step offers, read from the workstation's own tables: continents
and zones from tzdata's `zone1970.tab`, countries from `iso3166.tab`, locales from
`/usr/share/i18n/SUPPORTED`, keyboard layouts from the X11 rules list. Also returns `uiLanguages`
(the interface catalogs present), `current` (what is in force) and `saved`
(`/etc/labkiosk/localization.json`).

#### `POST /api/localization/configure`

Applies language, region, timezone, keyboard and clock. Body:
`{ uiLanguage, timezone, locale, keymap, keymapVariant, syncTime, time }`. `ntpServer` accepts one to four host names or addresses and configures `systemd-timesyncd`
through a drop-in; an empty value restores Debian's default pool. `time` is
`YYYY-MM-DD HH:MM:SS` and is used only when `syncTime` is false — which is the point of the step,
since NTP is unreachable until the network exists. Gated by the administrator token once the
workstation is installed, exactly like `/api/network/configure`. Every value is re-validated by
`/usr/local/sbin/labkiosk-localization`, which is the only program the agent runs through sudo.

#### `GET /i18n/<tag>.json`

An interface catalog. `en-US` ships in the image; other languages are files placed in
`/etc/labkiosk/i18n` on the data partition. The tag is matched against a pattern before it becomes
a path, and an unknown one returns `404`.

#### `GET /api/localization/languages`

Asks the organization's control plane which interface languages it offers, and marks the ones already
installed. Needs the network and an enrolment, which is why it is separate from
`/api/localization/options` — that one has to work on a workstation that has neither.

#### `POST /api/localization/language/download`

Body `{ tag }`. Fetches that catalog from the control plane, checks its size, shape and value types,
and stores it in `/etc/labkiosk/i18n`. Administrator token required once the workstation is
installed.

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
    { "ssid": "Organization-Users", "signal": 85, "bars": "▂▄▆█", "security": "WPA2", "inUse": false },
    { "ssid": "Organization-Guest", "signal": 60, "bars": "▂▄▆_", "security": "Open", "inUse": true }
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
    "ssid": "Organization-Users",
    "password": "SecretPassword123",
    "security": "WPA2",
    "hidden": false,
    "ipv4": { "mode": "custom_dns", "dns": ["1.1.1.1", "1.0.0.1"] },
    "ipv6": { "mode": "auto" },
    "proxy": {
      "enabled": true,
      "host": "proxy.organization.internal",
      "port": 8080,
      "bypass": "*.organization.internal, 10.0.0.0/8"
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
`boot/grub/labkiosk-password.cfg` on `LABKIOSK_ROOT` (read at `/run/live/medium/boot/grub/`, where
live-boot mounts it) and issues a 10-minute token for `/api/network/configure`.
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

Triggers automated disk installation to the specified target drive. The disk is erased and becomes
an image store (four partitions; the live medium's system image copied to
`images/<version>/` on `LABKIOSK_ROOT`); disks under 7 GiB are refused. Answers `400` on an
installed workstation (`labkiosk.installed=1` on the kernel command line).

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
