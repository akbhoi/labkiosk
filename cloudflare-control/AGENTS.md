# LabKiosk Cloudflare Control Plane — AI Agent Codex

> **Scope:** This document is the authoritative architectural specification and coding standard for the **Cloudflare Workers Control Plane**, Cloudflare D1 database, Web Crypto authentication, edge routing, multi-tenant scoping, and HTML/UI generation.
> For the client Debian 12 operating system and installer, refer to [`distro-builder/AGENTS.md`](../distro-builder/AGENTS.md). For master cross-cutting contracts, refer to the root [`AGENTS.md`](../AGENTS.md).

---

## 1. System Architecture Map

```text
cloudflare-control/
├── migrations/                         # Cloudflare D1 SQL migrations (0001..0007)
├── .dev.vars.example                   # Local secrets template for `wrangler dev`
├── wrangler.jsonc                      # Routes, D1 binding, hourly cron trigger
├── src/
│   ├── index.ts                        # Edge router, REST APIs, telemetry cache, scheduled()
│   ├── guard.ts                        # Tenant resolution, authorization, CSRF origin guard (MANDATORY)
│   ├── escape.ts                       # HTML / attribute / JSON escaping & safe URLs (MANDATORY)
│   ├── db.ts                           # D1 Database queries, SCHEMA_SQL & tenant seeding
│   ├── auth.ts                         # Native Web Crypto PBKDF2 authentication, CSP nonces
│   ├── d1_adapter.ts                   # Node 22+ native `node:sqlite` mock for local unit tests
│   ├── ui.ts                           # Teacher Lab Dashboard HTML/JS & multi-page sub-routes
│   ├── ui_layout.ts                    # Shared responsive layout shell, nav tabs, design tokens
│   ├── ui_landing.ts                   # Public SaaS Landing Page
│   ├── ui_portal.ts                    # Student Learning Portal (Educational Cards Grid)
│   ├── ui_super.ts                     # Super Admin Master Console (/super)
│   ├── ui_legal.ts                     # Legal compliance pages (/privacy, /terms)
│   └── types.ts                        # Strict TypeScript interfaces
└── test/worker.test.ts                 # Multi-tenant automated integration & security test suite
```

---

## 2. Invariant Rules for Control Plane & Edge Workers

### Rule 1: Zero NPM Dependencies in Cloudflare Worker
- The Cloudflare Worker control plane uses **0 runtime npm dependencies**.
- Hashing and session cryptography **must always use `crypto.subtle`** (Web Crypto API):
  - Algorithm: `PBKDF2-HMAC-SHA256`
  - Salt: 32 cryptographically random bytes (`crypto.getRandomValues`)
  - Iterations: 100,000
  - Key derivation: `deriveBits` producing 256 bits, encoded in hexadecimal.
- Never add external routing libraries, auth frameworks, or heavy database ORMs. Keep cold start under 10ms.

### Rule 2: Multi-Tenant Scoping, Privacy Isolation & Delegation
- Every database query in `db.ts` dealing with devices, commands, sessions, or portal apps **must filter by `tenant_id`**.
- The in-memory telemetry cache is partitioned by tenant ID: `tenantTelemetryCache[tenantKey]`. It is a cache only; `client_devices` in D1 is the source of truth, because worker isolates are per-colo and short-lived.
- **Nothing that two requests must agree on lives in module memory.** The active broadcast (`tenants.broadcast_url` / `broadcast_epoch`) and a workstation's remote-control details (`client_devices.vnc_password` / `remote_host`) are rows in D1.
- **Subdomain Routing & Apex Redirection**: School admin dashboards are located at `/admin` on their own subdomain (`https://<subdomain>.<baseDomain>/admin`). Accessing `/admin` on the base apex domain redirects (302) to the authenticated school admin's subdomain `/admin` (or `/super` for super admins).
- **Super Admin Privacy Isolation**: Super admins are strictly restricted from accessing any school's admin console (`/admin`), workstation telemetry, or remote desktop/VNC channel *except* for the dedicated `demo` school tenant. Super admin privileges permit approving custom domains, managing interface catalogs, and system maintenance, but protect institutional privacy.
- **Granular Staff Delegation & Sub-admins**: School admins can delegate management functions by creating staff accounts (`tenant_users` table) with roles (`sub_admin`, `teacher`, `lab_assistant`, `content_manager`) and granular permissions (`workstations`, `broadcast`, `portal`, `whitelist`, `teachers`, `settings`).
- **Customizable Subdomain & Lab Settings**: School admins can customize their subdomain (`POST /api/tenant/subdomain`), default home route (`home_route`: e.g. `/` vs `/home`), and tunnel domain (`tunnel_domain` for per-school Cloudflare Tunnels).
- **Never resolve a tenant by hand.** Call `resolveTenant()` in `guard.ts`. The `Host` header is authoritative; `?tenant=` / `X-Tenant` are honoured only on a local dev host, for a super admin (restricted to `demo`), for a session that already owns that tenant, or on an explicitly public route.
- **Never write a route without a guard.** Every endpoint that reads or changes a school's data calls `requireTenantAdmin()` or `requireTenantPermission()`; platform endpoints call `requireSuperAdmin()`; `/api/telemetry` calls `requireDevice()`. A route with no guard is a security vulnerability.
- A workstation's identity comes from its device token, never from the request body. `/api/telemetry` must ignore any `clientId` or tenant the payload claims.
- Only the `Host` header says where a request arrived. Never read `X-Forwarded-Host` (or any other caller-supplied header) to build a URL that is handed back to a workstation.

### Rule 2b: Interface Catalogs Are Platform Assets, Not Tenant Data
- `ui_catalogs` holds the translated interface text for the wizard and the kiosk top bar. It has no
  `tenant_id` and must not grow one: the product says the same thing to every school, and a
  workstation asks for its language **before** it is enrolled, so there is no tenant to scope by
  and no credential to present.
- Writes are super-admin only (`POST /api/super/i18n`, `DELETE /api/super/i18n/<tag>`), pass the
  CSRF origin check, and are sanitised into a flat map of string to string with size and count caps
  before they are stored. Reads (`GET /api/i18n`, `GET /i18n/<tag>.json`) are listed in
  `isPublicTenantRoute()` for exactly that reason.
- The Super Admin console (`ui_super.ts`, rendered at `/super`) provides a dedicated management
  section for viewing, uploading, and deleting these catalogs. In strict accordance with Rule 5, all
  modal interactions, uploads, and deletions attach event listeners via `data-action` and
  `addEventListener`, completely avoiding inline event handlers.
- Nothing tenant-specific may be put in a catalog, precisely because it is served to everyone.

### Rule 3: The Schema Has Two Homes
- `migrations/` is what a deployed D1 database has; `SCHEMA_SQL` in `db.ts` builds the in-memory database that tests and local development use. Both must be changed together.
- Add a **new** numbered migration file (e.g. `0006_feature.sql`); **never** edit an applied migration.
- `test/worker.test.ts` compares the two schemas and fails on drift.

### Rule 4: Escape Everything Rendered & Safe URLs
- Tenant data is attacker-controlled: school names, admin emails, portal card titles, and URLs arrive through registration or the teacher console.
- Server-side, every interpolation into a `ui*.ts` template goes through `escapeHtml()` / `escapeJson()` from `escape.ts`. `escapeJson()` is required for anything inlined into a `<script>` block.
- Client-side, build DOM nodes and assign `textContent`. Never concatenate a value into `innerHTML`, and never place one inside an inline `onclick=` attribute — attach listeners and pass ids through `dataset`.
- URLs that will be navigated to, redirected to, or rendered as `href` must pass `safeHttpUrl()` first.

### Rule 5: Nonce CSP, No Inline Event Handlers, Hardened Headers
- Every HTML response is built with `buildHtmlHeaders(nonce, ...)` in `index.ts`:
  - Nonce-based `Content-Security-Policy`
  - HSTS (`Strict-Transport-Security`, HTTPS only)
  - `X-Frame-Options: DENY` & `frame-ancestors 'none'`
  - `Permissions-Policy`
  - `Cross-Origin-Opener-Policy: same-origin`
- Every `render*Html()` takes the response `nonce` and stamps `nonce="${escapeAttr(nonce)}"` on each `<script>`.
- **No inline event handler attributes anywhere** (`onclick=`, `onsubmit=`, `onmouseover=`, ...): they are blocked by the CSP. Use `data-action` attributes and delegated event listeners (or `addEventListener`).
- `test/worker.test.ts` renders every page and fails if any script lacks the nonce or any `on*=` attribute is detected.

### Rule 5b: Left-Side Multi-Level Panels Design & Seamless Transitions
- The dashboard control planes (both School Admin `/admin/*` and Super Admin `/super/*`) use a unified **Left-Side Multi-Level Panels Architecture**:
  - **Level 1 (Primary Rail — 72px)**: Slim, persistent vertical bar with the brand icon, primary module icons (Workstations, Broadcast, Portal, Whitelist, Teachers, Settings), live stats counter, user avatar, and panel expand/collapse toggle.
  - **Level 2 (Secondary Action Panel — 260px)**: Context-aware sub-panel that expands seamlessly with hardware-accelerated CSS (`transform: translateX()`, `opacity`, `cubic-bezier(0.16, 1, 0.3, 1)`), providing module-specific sub-views, quick filters (All, Online, Locked), and batch action triggers.
  - **Content Area**: Fluid layout adapting smoothly to panel states without content jumping or horizontal scrollbars.
  - **Transitions & Micro-Interactions**: Hardware-accelerated transitions, 2026 CSS tokens, dark glassmorphism surfaces (`backdrop-filter: blur(12px)`), accessible contrast (WCAG 2.2 AA), and zero inline event handlers (`data-action` pattern).

### Rule 6: State-Changing Requests Prove Their Origin
- Cookie-authenticated `POST`/`DELETE` calls under `/api/` pass `rejectCrossSiteMutation()` in `guard.ts`: a browser-supplied `Origin` must be this host, the platform domain, or a dev host. Bearer-authenticated device routes are exempt.
- Passwords change only through `POST /api/auth/change-password`, which verifies the current password and revokes the account's other sessions.

### Rule 7: Fail Closed
- Missing configuration is an error, not a reason to fall back to something weaker.
- `getDatabase()` throws without a D1 binding unless `ALLOW_LOCAL_DB=1`.
- With a D1 binding present, `bootstrap()` in `index.ts` refuses to serve unless **both** `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` are set, and refuses a database whose migrations have not been applied (`assertSchemaCurrent()`); it never creates tables in production.
- Public endpoints are throttled per source address (`rateLimitWait` / `recordRateLimitHit` in `db.ts`): registration and failed enrolments. Reserved slugs (`RESERVED_SLUGS` in `guard.ts`) can neither be registered nor assigned.

---

## 3. Verification & Testing Playbook

### 1. TypeScript Strict Typecheck
Checks both `src/` (against Cloudflare Workers runtime) and `test/` (against Node types):
```bash
pnpm --prefix cloudflare-control run typecheck
```
*Expected result:* Exit code 0, zero errors.

### 2. Automated Multi-Tenant & Security Tests
```bash
pnpm --prefix cloudflare-control test
```
*Expected result:* All unit and integration tests passing. Uses Node 22 native `node:sqlite` in `d1_adapter.ts`.

**Testing Rule**: Whenever you add an API route, you MUST add its matching negative tests:
- Anonymous access rejection (`401`)
- Cross-tenant tampering rejection (`403` / `404`)
- Cross-site CSRF rejection
- Input validation & escaping checks

### 3. Local Dev Server
```bash
cd cloudflare-control
cp .dev.vars.example .dev.vars   # Edit secrets for local test
pnpm dev                        # predev applies migrations/ to local D1
```

---

## 4. Known Pitfalls & Solutions

| Issue | Root Cause | Solution |
| :--- | :--- | :--- |
| **`D1_EXEC_ERROR: incomplete input`** | Miniflare/workerd parses multiline SQL in `db.exec()` poorly on Windows CRLF. | Split SQL by `;`, normalize newlines (`replace(/\r\n/g, "\n")`), and execute each statement via `db.prepare(stmt).run()`. |
| **A button does nothing and console logs "Refused to execute inline event handler"** | The CSP allows only nonce-carrying scripts; an `onclick=` attribute was added to a template. | Use a `data-action` attribute and delegated event listeners (or `addEventListener`). |
| **A script block silently does not run** | Script tag was added without `nonce="${escapeAttr(nonce)}"`. | Pass the response `nonce` to all HTML renderers and stamp `nonce` on every `<script>`. |
| **"Columns of 'x' differ between SCHEMA_SQL and migrations/"** | The two copies of the database schema drifted. | Apply schema changes to both `migrations/` (new file) and `SCHEMA_SQL` in `src/db.ts`. |
| **"No D1 database bound" on startup** | Worker failed closed because `env.DB` was missing. | Bind `DB` in `wrangler.jsonc`, or set `ALLOW_LOCAL_DB=1` for local development/tests only. |
| **Workstations disagree about the active broadcast** | Broadcast state was stored in isolate memory, which differs across edge colos. | Store `broadcast_url` and `broadcast_epoch` in the `tenants` table in D1. |
| **Resetting Broadcast lands on SaaS landing page instead of school portal** | `resetBroadcastToPortal()` sent `origin + "/"` without tenant scoping. | Authoritatively resolve `portalUrlFor(tenant)` in `POST /api/command`. |
| **Single-Site Lockdown URL rejected without scheme** | URL lacked `https://` prefix (e.g. `canvas.institution.edu`). | `safeHttpUrl()` in `escape.ts` automatically prepends `https://` for scheme-less domains. |
| **Cloudflare Dashboard env vars overwritten on deploy** | Defining `vars` in `wrangler.jsonc` overrides Cloudflare dashboard variables. | Omit `vars` block from `wrangler.jsonc`. Manage production secrets via Cloudflare Dashboard / `wrangler secret`. |
