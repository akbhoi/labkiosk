---
name: labkiosk-control
description: Lab Kiosk Cloudflare Worker back end — adding or changing API routes in cloudflare-control/src/index.ts, tenant resolution and guards (guard.ts), staff delegation and roles, batch commands and workstation groups, CSRF/origin checks, Web Crypto auth, and the negative tests every route needs. Use when touching Worker request handling or security; use labkiosk-console-ui for rendered pages and labkiosk-d1-schema for schema changes.
---

# Lab Kiosk — Worker routes, guards & tenancy

Authoritative detail: `cloudflare-control/AGENTS.md` (Rules 1–2e, 6–7). This is the working checklist.

## Before writing a route

1. Read `src/types.ts`, `src/guard.ts`, `src/escape.ts`.
2. **Resolve the tenant with `resolveTenant()`** — never by hand. `Host` is authoritative;
   `?tenant=` / `X-Tenant` count only on a dev host, for a super admin (who may then open only the platform-owned demos, `src/demo.ts`), for
   a session that owns that tenant, or on a public route in `isPublicTenantRoute()`.
3. **Guard it**: `requireTenantPermission(db, session, tenant, "<perm>", …)` (or
   `requireTenantAdmin()` for membership-only reads), `requireSuperAdmin()` for platform routes,
   `requireDevice()` for workstation routes (identity from the token, never the body). Permissions:
   `workstations`, `broadcast`, `portal`, `whitelist`, `staff`, `settings`, `updates`. Anything
   exposing staff emails needs `staff`.
4. Cookie-authenticated `POST`/`DELETE` under `/api/` already pass `rejectCrossSiteMutation()` in
   `index.ts`; a dev-host `Origin` (`localhost`…) is same-site **only when the request itself is
   on a dev host**. Do not add state-changing routes outside `/api/`.
5. Consensus state (broadcasts, VNC details, sessions) lives in **D1** or the organization's
   **OrgHub** (live status, the command queue, sockets), never in module memory. The isolate's
   device-token cache (`guard.ts`) is a cache only, with a 60 s lifetime.
6. **A route that saves something a workstation sees** (allowlist, portal, mode, broadcast presets,
   customization, subdomain, suspension, custom domain) calls `notifyConfigChanged(env, tenantId)`
   after the write, or connected workstations keep the old value until the hub's 5-minute cache
   expires. Removing a workstation also calls the hub's `/remove-device`.
7. A new WebSocket route checks `Upgrade` (`426`), its guard, and — for a cookie session —
   `rejectCrossSiteSocket()` (a browser always sends `Origin` on a WebSocket; no `Origin` is refused).

## Staff delegation never escalates

- Roles `STAFF_ROLES` = `org_admin | sub_admin | operator | assistant | content_manager`;
  permissions `STAFF_PERMISSIONS`; validate both on the way in; `*` is never stored (full access =
  owning the tenant or `org_admin`).
- Every create/update/delete of staff calls `staffDelegationProblem()`: a non-co-admin delegate
  grants only what they hold, never appoints an `org_admin`, never edits their own row or a
  co-admin's.
- Adding staff refuses an email that already has an account (`409`) instead of linking another
  organization's user; removing staff deletes that user's sessions. Passwords go through
  `validatePasswordStrength()`.

## Batches, groups, commands

- Id lists: dedupe, cap at `MAX_BATCH_TARGETS` (500), and write `IN (…)` in `D1_IN_LIST_CHUNK` (90)
  slices — D1 binds at most 100 parameters.
- A name other rows reference (`workstation_groups.name` ← `client_devices.group_name`) is unique
  per tenant case-insensitively — checked by the route (`409`) and enforced by a unique index — and
  must exist before it is assigned (`404`).
- `POST /api/command`: `"all"` replaces named targets; `navigate`/`resetPortal` records broadcast
  state organization-wide for `"all"`, per workstation (`setClientsBroadcast()`) otherwise, then
  hands the command to the hub (`hubJson(env, tenantId, "/enqueue", …)`). Commands and payloads:
  see `labkiosk-core`.

## Over-the-air updates (`src/releases.ts`)

- `GET /api/devices/update` (`requireDevice()`): `{release: {version, kind, sizeBytes, url} | null}`,
  the newest unrevoked release of the organization's channel (`tenants.update_channel`; `beta`
  also takes `stable`). `503` while a release is offered but `RELEASES_BASE_URL` is unset or not
  https.
- `GET`/`POST /api/settings/updates` (`{channel}`), `POST /api/clients/check-update` and
  `POST /api/clients/install-update` (`{clientIds}` ≤ 500; unknown ids come back in `skipped` as
  `Not found`; install answers `409` when nothing is offered) need `updates`. Install goes
  through the hub's `/install-update`, which sends `install-update` only to workstations online
  and `ready` for that version and returns the rest with a reason.
- `GET /api/super/releases` (syncs from the optional `RELEASES` bucket, `503` without it),
  `POST /api/super/releases/classify {version, channel: beta|stable|null}` and
  `POST /api/super/releases/revoke {version}` (`409` once revoked) are `requireSuperAdmin()`;
  `releases` is a platform table (no `tenant_id`). Both changes reload every organization's hub.
- Audit actions: `release.classify`, `release.revoke`, `settings.update_channel`, `update.check`,
  `update.install`. `/api/command` never accepts `release-available` or `install-update`.

## Workstation problems and bug reports (Rule 2e)

- `POST /api/devices/boot-report` (`requireDevice()`, answered before sessions like `/api/telemetry`)
  → `src/boot_report.ts`: validates, keeps the newest on `client_devices.update_*`, and writes a
  failure/rollback/fallback/error to `workstation_issues`. **Never `writeAuditLog()` for a
  workstation's problem**: the audit log is what people did.
- `GET /api/workstation-issues` and `POST /api/settings/bug-reports` (`{ enabled, acceptTerms }`)
  need `settings`. Turning reports on answers `409` when the platform has no repository and `400`
  unless `acceptTerms === BUG_REPORT_TERMS_VERSION`; any change to the terms text at
  `/terms/bug-reports` (public, `isPublicTenantRoute()`) bumps that constant.
- `processBugReports()` (hourly cron) is the only code that talks to GitHub or Workers AI; it sends
  redacted text only and caps GitHub writes per run. `bug_reports` is platform-wide (no
  `tenant_id`), so only redacted, organization-free text goes in it.

## OrgHub (`src/org_hub.ts`) — one Durable Object per organization

- Reached only through `src/hub.ts` (`hubRequest`, `hubJson`, `hubUpgrade`, `notifyConfigChanged`),
  named by tenant id; every call carries `x-labkiosk-tenant`, and a hub refuses another
  organization's id (`409`). Nothing a caller sent reaches a hub on an upgrade: `hubUpgrade()` builds
  a fresh request with the identity the Worker verified.
- Hibernation rules: sockets are accepted with `ctx.acceptWebSocket` and tags; per-socket state goes
  in `serializeAttachment` (≤ 16 KB); timers are alarms; the ping is an auto-response. Anything kept
  in plain fields is a cache that may vanish between messages.
- D1 is written on connect, disconnect, a status change (batched by a 20 s alarm) and every
  5 minutes for an unchanged workstation — never per ping or per frame.
- Tests run a hub in-process (`LocalHubNamespace` in `src/local_do.ts`); `tsx` resolves
  `cloudflare:workers` to `test/shims/` through `tsconfig.runtime.json`.

## Routes worth knowing

`/admin/{workstations,apps-web,staff,settings}`; old `/admin/teachers`, `/admin/broadcast|portal|whitelist`
and `/super/schools` redirect. Staff API: `/api/tenant/staff` (list key `staff`), `…/update`,
`…/:id`. Never add another alias for `/` or `/home` (Rule 5g). Enrolment/`/api/status` send
`organizationName` + deprecated `schoolName`.

## Auth & fail-closed

PBKDF2-HMAC-SHA256, 100 000 iterations, 32-byte salt, 256 bits, `crypto.subtle` only — zero runtime
npm dependencies. With a D1 binding, `bootstrap()` refuses to serve without `SUPER_ADMIN_EMAIL` +
`SUPER_ADMIN_PASSWORD` or on an unmigrated schema (`assertSchemaCurrent()`). `ALLOW_LOCAL_DB=1`
is local-only: it also disables the production schema check and lets missing platform bindings
fall back to in-process stand-ins. Without it, `requiredBindingsProblem()` refuses to serve unless
`ORG_HUB`, `AUDIT_QUEUE`, `AUDIT_ARCHIVE`, `FLEET_METRICS`, `AUTH_RATE_LIMITER`,
`CUSTOM_HOSTNAMES`, `CF_API_TOKEN` and `CF_ZONE_ID` are all present. `AUTH_RATE_LIMITER` is a coarse
front layer on sign-in, registration and enrolment; the D1 lockouts behind it stay authoritative,
and a limiter fault is logged rather than failing sign-in. Configuration (`DEFAULT_DOMAIN`,
`ISO_DOWNLOAD_URL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, and the optional
`GITHUB_ISSUES_TOKEN` + `GITHUB_ISSUES_REPO`) lives in the Cloudflare dashboard / `wrangler secret`
and `.dev.vars` locally — never in `wrangler.jsonc` `vars` (deploy overwrites dashboard values).
Automatic bug reports also need the `AI` binding (`wrangler.jsonc`); without all three
`bugReportRepository()` is `null` and the feature is off. A new binding or outside service is
also named in the Privacy Policy (`ui_legal.ts`), which a test checks.

## Tests — mandatory for every route

```bash
pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test
```

Add negative tests: anonymous, cross-tenant (another organization's cookie), cross-site `Origin`,
invalid input, and for staff routes a delegate exceeding their permissions. On a production host
an anonymous request that names a tenant is refused with `403` before the route's `401`, so assert
"refused" (`401` or `403`), not one status. A device route needs a forged-token `401` and must
ignore a `?tenant=` or client id the request claims. Fixtures: `orgSessionCookie` (greenwood),
`rivalSessionCookie` (riverside), `superSessionCookie`.

Then check the behaviour in a browser — see `labkiosk-console-ui` §Verify.
