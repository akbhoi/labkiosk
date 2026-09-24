# Control Plane Internals

How `cloudflare-control/` is put together, and the rules for changing it.

---

## Files

```text
cloudflare-control/
├── migrations/             D1 SQL migrations 0001..0013
├── src/
│   ├── index.ts            Router, REST endpoints, telemetry cache, scheduled()
│   ├── guard.ts            Tenant resolution, authorization, CSRF origin guard
│   ├── escape.ts           HTML / attribute / JSON escaping, safe URLs
│   ├── db.ts               D1 queries, SCHEMA_SQL, tenant seeding
│   ├── auth.ts             Web Crypto PBKDF2, tokens, nonces, password policy
│   ├── d1_adapter.ts       node:sqlite mock for local tests
│   ├── ui.ts               Organization admin console router: selects page, wraps shell
│   ├── ui_admin_shared.ts  Shared context panel actions & client scripts
│   ├── ui_admin_workstations.ts Workstations fleet, groups & commands
│   ├── ui_admin_apps_web.ts     Apps & Web: broadcast, portal & allowlist
│   ├── ui_admin_staff.ts     Staff accounts, roles & permissions
│   ├── ui_admin_settings.ts     Settings: 4 tab panes & scrollable audit
│   ├── ui_tokens.ts        Design system tokens (colors, radii, easing)
│   ├── ui_layout.ts        Shared multi-level shell, headers & styles
│   ├── ui_landing.ts       Public SaaS landing page
│   ├── ui_org_home.ts   Organization homepage at subdomain root (/)
│   ├── ui_portal.ts        User Portal at /home
│   ├── ui_super.ts         Super Admin console (/super)
│   ├── ui_legal.ts         Legal compliance pages (/privacy, /terms)
│   └── types.ts            Strict TypeScript interfaces
├── test/worker.test.ts     Multi-tenant integration and security suite
├── .dev.vars.example       Local secrets template
├── tsconfig.json           src/ against @cloudflare/workers-types alone
├── tsconfig.test.json      test/ against @types/node
└── wrangler.jsonc          Routes, D1 binding, hourly cron
```

**Zero runtime npm dependencies.** Everything in `package.json` is a `devDependency`: `wrangler`, `typescript`, `tsx`, and two type packages. Never add a routing library, an auth framework, or an ORM — cold start must stay under 10 ms, and the supply-chain surface is deliberately empty.

---

## `index.ts` — the router

One `fetch()` handler containing a flat sequence of guarded blocks:

```ts
if (path === "/api/command" && method === "POST") {
  const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
  if (denied) return denied;
  …
}
```

No framework, no middleware stack, no decorators. Adding a route means adding a block — and the block is not complete without its guard.

### Order of operations

1. `bootstrap(env)` — fail-closed checks on secrets and schema.
2. `resolveTenant()` — the organization, from `Host`.
3. `rejectCrossSiteMutation()` — for cookie-authenticated mutations under `/api/`.
4. The route's guard.
5. The handler.
6. `buildHtmlHeaders(nonce, …)` for HTML responses.

### The telemetry cache

```ts
tenantTelemetryCache[tenantId][clientId] = record;
```

Partitioned by tenant, and a **cache only**. Worker isolates are per-colocation and short-lived, so this map can be empty on any given request. `client_devices` in D1 is the source of truth; the cache exists so the dashboard's frequent polls do not hit D1 for data that changed three seconds ago.

Lock and unlock update the cache on dispatch so the console reflects the new state without waiting a heartbeat.

### `scheduled()`

Invoked hourly by the cron in `wrangler.jsonc`. Purges expired sessions, delivered commands, and stale rate-limit rows. Command rows are also purged opportunistically on dispatch, so the queue does not depend on the cron alone.

---

## `guard.ts` — the security boundary

| Export | Purpose |
| :--- | :--- |
| `hostname(request)` | The `Host` header, normalised |
| `isDevHost(request)` | Is this `localhost`, `127.0.0.1`, `host.docker.internal`, …? |
| `isHostUnder(host, base)` | Is `host` a subdomain of `base`? |
| `hostSubdomain(request, base)` | The slug, or `null` for reserved and platform hosts |
| `isReservedSlug(slug)` | Membership of `RESERVED_SLUGS` |
| `resolveTenant(options)` | The authoritative tenant for this request |
| `rejectCrossSiteMutation(…)` | `403` for an untrusted `Origin` on a cookie-authenticated mutation |
| `requireSuperAdmin(session, headers)` | |
| `requireTenantAdmin(session, tenant, headers)` | |
| `requireDevice(request, db, headers)` | Validates the bearer token |
| `jsonError(message, status, headers)` | Consistent error shape |

`DEV_HOSTS` covers `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, `host.docker.internal`, and `host.containers.internal`.

`RESERVED_SLUGS`: `www`, `super`, `labkiosk`, `api`, `admin`, `portal`, `status`, `mail`, `app`, `kiosk`, `root`.

---

## `escape.ts` — output safety

| Export | Use |
| :--- | :--- |
| `escapeHtml(value)` | Any interpolation into HTML text |
| `escapeAttr(value)` | Alias of `escapeHtml`; use it in attributes for intent |
| `escapeJson(value)` | **Required** for anything inlined into a `<script>` block. Also escapes U+2028 / U+2029, which are valid JSON but terminate a JS line |
| `cleanSubdomain(raw)` | Normalises a requested slug |
| `cleanCustomDomain(raw)` | Validates an FQDN; also used for `remoteHost` from telemetry |
| `safeHttpUrl(raw)` | `http(s)` only; prepends `https://` to a scheme-less domain, so `canvas.example.com` is accepted |

---

## `auth.ts` — cryptography

```ts
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 256;
```

| Export | Purpose |
| :--- | :--- |
| `hashPassword(password, salt?)` | PBKDF2-HMAC-SHA256, 32-byte salt, 256 bits, hex |
| `verifyPassword(…)` | Constant-time comparison |
| `timingSafeEqual(a, b)` | |
| `sha256Hex(input)` | Session and device token hashing |
| `generateSessionToken()` / `generateDeviceToken()` | 32 random bytes, hex |
| `generateEnrollmentKey()` | The organization's `KEY-XXXX-…` |
| `generateNonce()` | Per-response CSP nonce |
| `validatePasswordStrength(password)` | Returns a message, or `null` if acceptable |
| `isPlausibleEmail(value)` | |
| `parseCookies` / `createSessionCookie` / `clearSessionCookie` | `HttpOnly; Secure; SameSite=Lax` |

Only token *hashes* reach the database. A session or device token exists in plaintext solely in the client that was issued it.

---

## `db.ts` — data access

Every function touching devices, commands, sessions, or portal apps takes a `tenantId` and filters on it. That is not a convention — it is the mechanism that makes the platform multi-tenant.

Notable helpers:

| Function | Notes |
| :--- | :--- |
| `buildEffectiveWhitelist(db, tenantId)` | Unions `tenant_whitelist` with every `portal_sites.domain`, computed per heartbeat rather than stored |
| `popCommandsForClient(db, tenantId, clientId)` | Records a `command_deliveries` receipt so each command runs exactly once |
| `enqueueCommand(db, {…})` | Writes the row with an expiry |
| `purgeExpiredCommands(db)` | Called opportunistically and from `scheduled()` |
| `upsertClientDevice(db, {…})` | One row per `tenant_id:client_id` |
| `rateLimitWait` / `recordRateLimitHit` | Public-endpoint throttling |
| `writeAuditLog(db, {…})` | |
| `assertSchemaCurrent(db)` | Refuses to serve an un-migrated database |

`SCHEMA_SQL` lives here and must mirror `migrations/` exactly. → [Database Schema](Database-Schema#the-schema-has-two-homes)

---

## `ui*.ts` — server-rendered consoles

Each exports a `render*Html(nonce, …)` that returns a complete document. Three rules, all asserted by the test suite:

1. **Every `<script>` carries `nonce="${escapeAttr(nonce)}"`.** A script tag without it silently does not run.
2. **No inline event handlers.** Use `data-action` attributes with a delegated listener, or `addEventListener`. An `onclick=` produces *"Refused to execute inline event handler"* and a button that does nothing.
3. **Every dynamic value is escaped**, server-side through `escape.ts` and client-side by building nodes and assigning `textContent`.

Pass ids through `dataset`, never by concatenating a value into an `onclick=` attribute.

---

## `d1_adapter.ts` — the test database

Implements the D1 interface over Node 22's native `node:sqlite`. No npm dependency, and no Miniflare needed for unit tests. Enabled with `ALLOW_LOCAL_DB=1`; without that flag a missing D1 binding is a hard failure rather than silent data loss.

It splits SQL on `;`, normalises `\r\n` to `\n`, and runs each statement through `db.prepare(stmt).run()` — because Miniflare's `db.exec()` mis-parses multiline SQL with CRLF line endings and produces `D1_EXEC_ERROR: incomplete input`.

---

## Adding a route: the checklist

1. Read `types.ts` before changing any API contract.
2. Read `guard.ts` and `escape.ts` before writing the handler.
3. Add the block to `index.ts`, with its guard. Cookie-authenticated mutations already pass the CSRF check; do not add state-changing routes outside `/api/`.
4. If it touches the schema: a **new** numbered migration **and** the mirror in `SCHEMA_SQL`.
5. If it renders HTML: nonce on every script, no `on*=`, everything escaped.
6. If it is consensus state: it goes in D1, never a module-level variable.
7. **Add negative tests** — anonymous `401`, cross-tenant `403`/`404`, cross-site CSRF rejection, input validation and escaping.
8. `pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test`

→ [Testing Guide](Testing-Guide) · [Development Workflow](Development-Workflow) · [REST API Reference](REST-API-Reference)
