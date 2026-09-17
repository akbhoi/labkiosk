# Architecture Overview

Lab Kiosk is two independently deployable systems joined by one authenticated HTTPS contract.

- The **control plane** is a single Cloudflare Worker plus a D1 database. It is multi-tenant: one deployment serves every school.
- The **client** is a Debian 12 image that boots into a locked Chromium session and runs a small Python daemon.

Nothing else is required. There is no per-school server, no on-premise appliance, and no VPN.

---

## System map

```text
+---------------------------------------------------------------------------------------+
|                               CLOUDFLARE EDGE SAAS LAYER                              |
|                                                                                       |
|   [ Public Visitors ]          [ Platform Owner ]           [ School Teachers ]       |
|            |                           |                             |                |
|            v                           v                             v                |
|   labkiosk.example.edu      labkiosk.example.edu/super   greenwood.labkiosk.example.edu|
|    (Landing page & ISO)      (Super Admin console)         (Teacher Lab Dashboard)    |
|            |                           |                             |                |
|            +---------------------------+-----------------------------+                |
|                                        |                                              |
|                                        v                                              |
|                     [ Cloudflare Worker router: src/index.ts ]                        |
|                        |-- auth.ts    Web Crypto PBKDF2, sessions, nonces             |
|                        |-- guard.ts   Tenant resolution, authorization, CSRF origin   |
|                        |-- escape.ts  HTML / attribute / JSON escaping, safe URLs     |
|                        |-- db.ts      D1 queries, SCHEMA_SQL, tenant seeding          |
|                        |-- ui*.ts     Server-rendered consoles, nonce CSP             |
|                        `-- scheduled() Hourly housekeeping cron                       |
|                                        |                                              |
|                                        v                                              |
|                          [ Cloudflare D1 (SQLite at the edge) ]                       |
|                          + per-isolate in-memory telemetry cache                      |
+---------------------------------------------------------------------------------------+
                                         ^
                                         | HTTPS: telemetry up, commands down
+---------------------------------------------------------------------------------------+
|                      CLIENT WORKSTATION LAYER (Intel thin clients)                    |
|                                                                                       |
|   Debian 12, Linux 6.1, overlayroot="tmpfs" (every write lands in RAM)                |
|   Xorg + Openbox, empty keybinding table, VT switching disabled, TTYs masked          |
|                                                                                       |
|   [ Chromium --kiosk ] <----- MV3 extension (--load-extension, unpacked)              |
|         |                       |-- content.js     Nav bar + lock curtain (Shadow DOM)|
|         |                       `-- background.js  Service worker -> agent (loopback) |
|         |-- Top-level native navigation (no iframes, full hardware acceleration)      |
|         `-- Managed enterprise policy (URLBlocklist deny-all + dynamic URLAllowlist)  |
|                                                                                       |
|   [ Python 3 agent: /opt/labkiosk/agent/agent.py ]                                    |
|         |-- Loopback API on 127.0.0.1:8888 (setup wizard, install, status)            |
|         |-- 3-second authenticated heartbeat with JPEG screen thumbnail               |
|         `-- Chromium policy synchronisation and command execution                     |
|                                                                                       |
|   [ Remote control gateway ]                                                          |
|         `-- x11vnc :5900 -> websockify 127.0.0.1:6080 -> Cloudflare Tunnel            |
+---------------------------------------------------------------------------------------+
```

---

## The three planes

### 1. Control plane — stateless compute, durable D1

`src/index.ts` is a flat router: one `if (path === ... && method === ...)` block per endpoint, in a single `fetch()` handler. There is no framework. Each block resolves its tenant, applies a guard, and returns JSON or nonce-stamped HTML.

The critical architectural rule is that **worker isolates are per-colocation and short-lived**, so nothing that two requests must agree on may live in module memory:

| State | Where it lives | Why |
| :--- | :--- | :--- |
| Active broadcast URL and epoch | `tenants.broadcast_url` / `broadcast_epoch` in D1 | Workstations hitting different colos must see the same lesson. |
| Device VNC password and tunnel host | `client_devices.vnc_password` / `remote_host` in D1 | The teacher's browser and the workstation's heartbeat land in different isolates. |
| Domain allowlist | `tenant_whitelist` rows in D1 | Previously a module global shared across every tenant, and lost on isolate recycle. |
| Latest thumbnail and liveness | `tenantTelemetryCache` **and** `client_devices` | The cache is an optimisation only; D1 is the source of truth. |

### 2. Transport — one contract, two directions

A workstation's entire relationship with the platform is a single endpoint called every three seconds:

```text
POST /api/telemetry
Authorization: Bearer <device token>

   up  ->  clientNum, activeUrl, isLocked, thumbnail?, vncPassword?, remoteHost?
 down  <-  commands[], whitelist[], mode, targetUrl, broadcastUrl, broadcastEpoch
```

The device token, never the request body, decides which workstation and which tenant the request belongs to. A payload claiming a different `clientId` is ignored.

That single loop delivers everything: fleet liveness, screen thumbnails, teacher commands, the Chromium allowlist, and the authoritative lesson URL. There is no push channel, no WebSocket, and no inbound connection to the school's network.

→ [REST API Reference](REST-API-Reference) for the full catalogue.

### 3. Client — immutable by construction

The client's defining property is that **it does not keep anything**. `overlayroot="tmpfs"` mounts the real root filesystem read-only and layers a RAM overlay on top. Browser profiles, caches, logs, downloads, and student artefacts all land in that overlay and are gone at power-off.

The one deliberate exception exists because enrolment has to survive a reboot: `labkiosk-install` creates a 512 MiB `LABKIOSK_DATA` partition and mounts it at `/etc/labkiosk`, which is where the device token lives. Without it, an installed workstation would forget its enrolment on the next boot.

→ [Kiosk Hardening](Kiosk-Hardening) for the lockdown layers.

---

## Tenant resolution

The school a request belongs to is derived from the **`Host` header**, authoritatively, in `resolveTenant()` (`src/guard.ts`). Nothing else is trusted by default.

```text
greenwood.labkiosk.example.edu  ->  subdomain "greenwood"
kiosk.greenwood.edu             ->  approved custom domain lookup
labkiosk.example.edu            ->  platform apex: landing page, no tenant
```

`?tenant=<slug>` and the `X-Tenant` header are honoured **only** when one of these holds:

- the request arrived on a development host (`localhost`, `127.0.0.1`, `host.docker.internal`, …), or
- the caller holds an active `super_admin` session, or
- the caller's session already owns that tenant, or
- the route is explicitly public (`/`, `/portal`, `/api/status`, `/api/portal-sites`, `/api/devices/enroll`, `/api/telemetry`).

`X-Forwarded-Host` is never read. A set of [reserved slugs](Configuration-Reference#reserved-subdomains) — `www`, `super`, `api`, `admin`, `portal`, `status`, `mail`, `app`, `kiosk`, `labkiosk`, `root` — can be neither registered nor resolved as a school.

---

## Request lifecycle

Every request passes the same gauntlet before it reaches a handler:

1. **`bootstrap(env)`** — refuses to serve if a D1 binding exists but `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` are unset, or if migrations have not been applied (`assertSchemaCurrent()`). A deployed worker never creates tables at runtime.
2. **`resolveTenant()`** — establishes the school from `Host`, per the rules above.
3. **`rejectCrossSiteMutation()`** — for cookie-authenticated `POST`/`DELETE` under `/api/`, requires a browser `Origin` matching this host, the platform domain, or a dev host. Bearer-authenticated device routes are exempt because they carry no ambient credential.
4. **A guard** — `requireTenantAdmin()`, `requireSuperAdmin()`, or `requireDevice()`. A route with no guard is treated as a security defect, and the test suite asserts coverage.
5. **The handler**, whose every interpolation into HTML goes through `escapeHtml()` / `escapeAttr()` / `escapeJson()`, and whose every navigable URL goes through `safeHttpUrl()`.
6. **`buildHtmlHeaders(nonce, …)`** for HTML responses — nonce CSP, HSTS, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`.

→ [Security Model](Security-Model) for the reasoning behind each layer.

---

## Two operating modes

A school chooses one, and it is delivered to workstations in the telemetry response as `mode`:

| Mode | Behaviour |
| :--- | :--- |
| `portal` | Workstations land on the Student Learning Portal: a grid of approved application cards, curated by the teacher. |
| `single_url` | Workstations are locked to one destination — an LMS, an exam platform, a library catalogue — with no launcher at all. |

Either mode can be temporarily overridden by a **broadcast**: the teacher pushes a URL to the whole lab at once, and it persists on the tenant row until reset. A broadcast is not its own command type; it is `navigate` plus a monotonic `broadcastEpoch` that lets a workstation tell a new broadcast from a replayed one.

---

## Repository layout

```text
labkiosk/
├── cloudflare-control/      Worker, D1 migrations, tests
├── distro-builder/          live-build ISO pipeline, client source, installer
├── docker-test/             Workstation simulator entrypoint + docs
├── docs/                    In-repo deployment, remote control, API specs
├── skills/                  AI agent operating procedures
├── wiki/                    This wiki's source
├── AGENTS.md                Master engineering codex
└── Dockerfile               The simulator image
```

→ [Control Plane Internals](Control-Plane-Internals) · [Client Agent](Client-Agent) · [Development Workflow](Development-Workflow)
