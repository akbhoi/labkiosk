---
name: labkiosk-control
description: Lab Kiosk Cloudflare Worker back end — adding or changing API routes in cloudflare-control/src/index.ts, tenant resolution and guards (guard.ts), staff delegation and roles, batch commands and workstation groups, CSRF/origin checks, Web Crypto auth, and the negative tests every route needs. Use when touching Worker request handling or security; use labkiosk-console-ui for rendered pages and labkiosk-d1-schema for schema changes.
---

# Lab Kiosk — Worker routes, guards & tenancy

Authoritative detail: `cloudflare-control/AGENTS.md` (Rules 1–2c, 6–7). This is the working checklist.

## Before writing a route

1. Read `src/types.ts`, `src/guard.ts`, `src/escape.ts`.
2. **Resolve the tenant with `resolveTenant()`** — never by hand. `Host` is authoritative;
   `?tenant=` / `X-Tenant` count only on a dev host, for a super admin (restricted to `demo`), for
   a session that owns that tenant, or on a public route in `isPublicTenantRoute()`.
3. **Guard it**: `requireTenantPermission(db, session, tenant, "<perm>", …)` (or
   `requireTenantAdmin()` for membership-only reads), `requireSuperAdmin()` for platform routes,
   `requireDevice()` for workstation routes (identity from the token, never the body). Permissions:
   `workstations`, `broadcast`, `portal`, `whitelist`, `staff`, `settings`. Anything exposing staff
   emails needs `staff`.
4. Cookie-authenticated `POST`/`DELETE` under `/api/` already pass `rejectCrossSiteMutation()` in
   `index.ts`; a dev-host `Origin` (`localhost`…) is same-site **only when the request itself is
   on a dev host**. Do not add state-changing routes outside `/api/`.
5. Consensus state (broadcasts, VNC details, sessions) lives in **D1**, never in module memory;
   `tenantTelemetryCache` is a cache only.

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
  per tenant case-insensitively and must exist before it is assigned (`404`).
- `POST /api/command`: `"all"` replaces named targets; `navigate`/`resetPortal` records broadcast
  state organization-wide for `"all"`, per workstation (`setClientsBroadcast()`) otherwise.
  Commands and payloads: see `labkiosk-core`.

## Routes worth knowing

`/admin/{workstations,apps-web,staff,settings}`; old `/admin/teachers`, `/admin/broadcast|portal|whitelist`
and `/super/schools` redirect. Staff API: `/api/tenant/staff` (list key `staff`), `…/update`,
`…/:id`. Never add another alias for `/` or `/home` (Rule 5g). Enrolment/`/api/status` send
`organizationName` + deprecated `schoolName`.

## Auth & fail-closed

PBKDF2-HMAC-SHA256, 100 000 iterations, 32-byte salt, 256 bits, `crypto.subtle` only — zero runtime
npm dependencies. With a D1 binding, `bootstrap()` refuses to serve without `SUPER_ADMIN_EMAIL` +
`SUPER_ADMIN_PASSWORD` or on an unmigrated schema (`assertSchemaCurrent()`). `ALLOW_LOCAL_DB=1`
is local-only: it also disables the production schema check. Configuration (`DEFAULT_DOMAIN`,
`ISO_DOWNLOAD_URL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`) lives in the Cloudflare dashboard / `wrangler secret` and `.dev.vars` locally — never in
`wrangler.jsonc` `vars` (deploy overwrites dashboard values).

## Tests — mandatory for every route

```bash
pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test
```

Add negative tests: anonymous, cross-tenant (another organization's cookie), cross-site `Origin`,
invalid input, and for staff routes a delegate exceeding their permissions. On a production host
an anonymous request that names a tenant is refused with `403` before the route's `401`, so assert
"refused" (`401` or `403`), not one status. Fixtures: `orgSessionCookie` (greenwood),
`rivalSessionCookie` (riverside), `superSessionCookie`.

Then check the behaviour in a browser — see `labkiosk-console-ui` §Verify.
