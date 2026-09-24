# Cloudflare Control Plane

[← Back to Documentation Hub](../README.md#documentation-hub)

The serverless multi-tenant edge control plane for Lab Kiosk, built on Cloudflare Workers and Cloudflare D1 SQL.

---

## 🌟 Overview & Architectural Invariants

The control plane handles tenant routing, operator management dashboards, user portal launches, device telemetry ingestion, screen freeze commands, and remote desktop coordination across all organizations.

### Core Invariants

1. **Zero Runtime NPM Dependencies:**
   - The worker runs purely on standard Web APIs and Cloudflare runtime primitives.
   - Eliminates supply-chain risks and ensures cold-start latency remains under 10ms.

2. **Native Web Crypto Authentication:**
   - Password hashing and verification use native `crypto.subtle` with `PBKDF2-HMAC-SHA256`.
   - Salt: 32 cryptographically secure random bytes (`crypto.getRandomValues`).
   - Work factor: 100,000 iterations producing 256 derived bits encoded in hex.
   - Session tokens are random 32-byte hex strings stored with SHA-256 hashes in D1.
   - Cookies are marked `HttpOnly; Secure; SameSite=Lax` and scoped to the parent domain.

3. **Multi-Tenant Scoping, Privacy Isolation & Delegation:**
   - Organization tenants are authoritatively resolved from the incoming `Host` header via `resolveTenant()` in `src/guard.ts`.
   - Query overrides (`?tenant=local-demo`) and `X-Tenant` headers are permitted **only** on local development hosts (`localhost`, `127.0.0.1`, `*.local`) or for authenticated platform super-admins (restricted to `demo`).
   - Organization admin consoles reside at `/admin` on their own subdomain (`https://<subdomain>.<baseDomain>/admin`); apex domain `/admin` redirects to the organization's subdomain.
   - Super admins are restricted from accessing any organization's admin console, telemetry, or VNC remote-control *except* for the platform's own demo organizations (`web-demo` (the hosted site), `local-demo` (a local VM) and `docker-demo` (the Docker simulator)), preserving each organization's privacy.
   - Organization admins can delegate management tasks to sub-admins and operators via `tenant_users` with granular permissions (`workstations`, `apps-web`, `staff`, `settings`, with backward-compatible support for legacy `broadcast`, `portal`, `whitelist`).
   - Every database query in `src/db.ts` filters explicitly by `tenant_id`.
   - Telemetry cache (`tenantTelemetryCache`) is partitioned by tenant ID and serves as an ephemeral cache only; D1 `client_devices` is the single source of truth across worker isolates.
   - Active broadcast URL and epoch reside in D1 (`tenants.broadcast_url` / `broadcast_epoch`), preventing colo isolate drift.

4. **Defense-in-Depth Security & Browser Hardening:**
   - **Origin Guard:** Cookie-authenticated state-changing calls (`POST`, `DELETE`) pass `rejectCrossSiteMutation()` in `src/guard.ts`. Requests with mismatched cross-site `Origin` headers are rejected with `403 Forbidden`.
   - **Nonce-Based CSP:** Every HTML response generates a cryptographically random nonce stamped on all `<script>` tags. Inline event handlers (`onclick=`, `onsubmit=`) are strictly banned across all templates.
   - **Response Headers:** Responses enforce HSTS, `frame-ancestors 'none'`, `Cross-Origin-Opener-Policy: same-origin`, and `Permissions-Policy`.
   - **Strict Escaping:** Every dynamic string interpolated into HTML templates is sanitized via `escapeHtml()`, `escapeAttr()`, `escapeJson()`, or `safeHttpUrl()` from `src/escape.ts`.
   - **Fail Closed:** The worker refuses to boot if secrets (`SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`) are missing, if D1 is unbound (unless `ALLOW_LOCAL_DB=1`), or if database migrations are unapplied.

---

## 📁 Directory Structure

```text
cloudflare-control/
├── migrations/                # Cloudflare D1 SQL schema migrations (0001..0013)
├── src/
│   ├── index.ts               # Worker router, REST endpoints, telemetry cache, scheduled()
│   ├── guard.ts               # Tenant resolution, authorization guards, CSRF origin checks
│   ├── escape.ts              # HTML / attribute / JSON escaping and URL validation
│   ├── db.ts                  # D1 database queries, schema definitions, tenant seeding
│   ├── auth.ts                # Web Crypto PBKDF2 authentication, nonces, password policy
│   ├── d1_adapter.ts          # Node 22+ native node:sqlite mock for local testing
│   ├── ui.ts                  # Organization admin console: picks the page, fills the shell
│   ├── ui_admin_shared.ts     # Tenant API scope + Level 2 context panel behaviour
│   ├── ui_admin_*.ts          # One module per admin page (markup + panel + script)
│   ├── ui_tokens.ts           # The one declaration of the design language (colours, radii, easing)
│   ├── ui_layout.ts           # Shared shell: 72px rail, 272px context panel, primitives
│   ├── ui_landing.ts          # Public SaaS landing page and registration
│   ├── ui_org_home.ts         # The organization homepage served at the subdomain root
│   ├── ui_portal.ts           # User Portal (Approved Apps Grid)
│   ├── ui_super.ts            # Super Admin Master Console (/super)
│   ├── ui_legal.ts            # Legal compliance pages (/privacy, /terms)
│   └── types.ts               # TypeScript interfaces and telemetry models
├── test/
│   └── worker.test.ts         # Automated integration and security test suite
├── .dev.vars.example          # Local development secrets template
├── tsconfig.json              # Worker runtime TypeScript configuration (no Node globals)
├── tsconfig.test.json         # Test-specific TypeScript configuration (with @types/node)
└── wrangler.jsonc             # Cloudflare Wrangler deployment configuration
```

---

## 🛠️ Local Development

### 1. Prerequisites
- **Node.js:** v22.0.0 or higher
- **pnpm:** v9.0.0 or higher

### 2. Installation
```bash
cd cloudflare-control
pnpm install
```

### 3. Local Secrets Setup
Copy the example secrets file and configure local credentials:
```bash
cp .dev.vars.example .dev.vars
```
Edit `.dev.vars`:
```ini
SUPER_ADMIN_EMAIL=admin@labkiosk.local
SUPER_ADMIN_PASSWORD=LocalDevPassword123!
```

### 4. Start Development Server
```bash
pnpm dev
```
> [!NOTE]
> The `pnpm dev` script automatically triggers `predev`, which applies all migrations from `migrations/` into the local D1 SQLite store (`.wrangler/state/v3/d1`). The worker refuses to serve until migrations are applied.

### 5. Checking the UI Without Wrangler
`test/dev_server.ts` serves the same worker over plain Node on the same port,
backed by the in-memory `node:sqlite` adapter. It needs no D1 database, no
`.dev.vars` and no migrations, which makes it the quickest way to look at a
page or drive it from a browser:
```bash
pnpm --prefix cloudflare-control exec tsx test/dev_server.ts
```
It seeds the three demo organizations (`web-demo` (the hosted site), `local-demo` (a local VM) and `docker-demo` (the Docker simulator)) and a super admin (`admin@akbhoi.com` /
`SuperAdminPassword2026!`, set at the top of that file). Use `pnpm dev` instead
whenever the change touches D1 itself, migrations or Workers runtime behaviour.

### 6. Local Endpoints
Once running on `http://localhost:8787`:
- **Public SaaS Landing Page:** `http://localhost:8787/`
- **Organization Homepage:** `http://localhost:8787/?tenant=local-demo`
- **User Portal:** `http://localhost:8787/home?tenant=local-demo`
- **Operator Console:** `http://localhost:8787/admin?tenant=local-demo` (the super admin may open `web-demo`, `local-demo` and `docker-demo`; any other organization signs in with its own account)
- **Super Admin Platform Console:** `http://localhost:8787/super` (Sign in with credentials from `.dev.vars`)

> [!NOTE]
> On a dev host there is no organization subdomain, so the tenant travels as
> `?tenant=<slug>`. The dashboard keeps it on every link and every API call it
> makes; in production the organization's own subdomain carries it instead.

---

## 🧪 Testing & Verification

### Strict TypeScript Typechecking
The project enforces strict separation between Worker runtime types and Node.js testing types:
```bash
pnpm run typecheck
```
- Validates `src/` against `@cloudflare/workers-types` alone (preventing accidental Node API dependencies).
- Validates `test/` against `@types/node`.

### Automated Test Suite
Run the 60+ automated integration and security tests:
```bash
pnpm test
```
The test suite utilizes `src/d1_adapter.ts` backed by Node 22's native `node:sqlite` engine (`ALLOW_LOCAL_DB=1`).

Key test validations include:
- **Authorization & Isolation:** Ensures unauthenticated and cross-tenant API requests return `401` / `403`.
- **Negative Security Checks:** Hostile script injections in tenant names/app cards, CSRF origin spoofing, and forged device tokens.
- **Schema Agreement:** Asserts that `SCHEMA_SQL` in `src/db.ts` matches all table definitions in `migrations/`.
- **CSP & Markup Integrity:** Verifies all HTML responses carry valid nonces, contain zero inline `on*=` event handlers, and maintain balanced modal depths.

---

## 🗄️ Database Migrations

Cloudflare D1 schema migrations are tracked in two places:
1. `migrations/000X_*.sql`: Numbered files executed sequentially by Wrangler in production.
2. `src/db.ts` (`SCHEMA_SQL`): Synchronized schema used by the in-memory test adapter and `assertSchemaCurrent()`.

### Creating a New Migration
1. Create the next numbered file in `migrations/` (never edit or rename one that has been applied).
2. Add the corresponding `CREATE TABLE` or `ALTER TABLE` statement into `SCHEMA_SQL` in `src/db.ts`.
3. Run `pnpm test` — the schema drift test will assert that both definitions match.

---

## 🚀 Production Deployment

For complete instructions on provisioning Cloudflare D1, configuring secrets, deploying the worker, setting up wildcard DNS, and setting up CI/CD, refer to the [Production Deployment Guide](../docs/DEPLOYMENT.md).
