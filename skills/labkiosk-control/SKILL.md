---
name: labkiosk-control
description: Engineering, debugging, and verification procedures for the LabKiosk Cloudflare Workers Control Plane (Edge SaaS), Cloudflare D1 SQL database, native Web Crypto PBKDF2 authentication, multi-tenant authorization guards, nonce CSP, and automated unit/integration test suite. Use when modifying worker routes, database migrations, security guards, admin console UI, user portal, or super admin console.
---

# Lab Kiosk Cloudflare Control Plane Engineering Skill

This skill guides AI coding assistants through authoring, modifying, testing, and verifying the **Cloudflare Workers Multi-Tenant SaaS Platform**, Cloudflare D1 database, and web user interfaces.

> **Architecture Reference:** Read [`cloudflare-control/AGENTS.md`](../../cloudflare-control/AGENTS.md) before making architectural changes.

---

## 1. Operating Procedures

### A. Modifying Routes & Endpoints
1. Inspect `cloudflare-control/src/types.ts` before editing API contracts.
2. **Mandatory Guarding:**
   - Every route that accesses tenant data MUST call `resolveTenant()` and `requireTenantAdmin()` from `src/guard.ts`,
     or `requireTenantPermission()` with the module's permission (`workstations`, `broadcast`, `portal`,
     `whitelist`, `staff`, `settings`). Anything that exposes staff emails needs `staff`.
   - Every platform administrative route MUST call `requireSuperAdmin()`.
   - Device routes (`/api/telemetry`) MUST call `requireDevice()`.
   - Cookie-authenticated mutations (`POST`/`DELETE`) MUST pass `rejectCrossSiteMutation()`. A dev-host
     `Origin` is same-site only when the request itself is on a dev host.
3. **Staff Delegation Never Escalates:**
   - Validate roles against `STAFF_ROLES` and permissions against `STAFF_PERMISSIONS`; never store `*`.
   - Any route that creates, changes or removes staff calls `staffDelegationProblem()`: a non-co-admin
     delegate grants only what they hold, never appoints an `org_admin`, and never edits their own
     account or a co-administrator's.
   - Never link an existing account into an organization (`409`), and end a removed account's sessions.
4. **Bound Every Batch:**
   - Cap id lists (`MAX_BATCH_TARGETS`, 500) and dedupe them. D1 binds at most 100 parameters per
     statement, so write `IN (...)` lists in `D1_IN_LIST_CHUNK` (90) slices.
   - A name that other rows reference (e.g. `workstation_groups.name` via `client_devices.group_name`)
     must be unique per tenant and must exist before it is assigned.
5. **Never Use Module Memory for Consensus:**
   - State that multiple edge isolates or requests must agree on (e.g. active broadcast URL, workstation remote passwords) MUST reside in D1.

### B. Modifying the Database Schema
1. **The Schema Has Two Homes:**
   - Add a **new** numbered migration file under `cloudflare-control/migrations/` (e.g. `0006_feature.sql`). Never edit an applied migration.
   - Update `SCHEMA_SQL` inside `cloudflare-control/src/db.ts` to mirror the new tables or columns.
   - Ensure all queries filter by `tenant_id`.

### C. Modifying UI Templates (`ui*.ts`)
1. **CSP Nonce Requirement:** Every `<script>` tag MUST include `nonce="${escapeAttr(nonce)}"`.
2. **Zero Inline Event Handlers:** Do not use `onclick=`, `onsubmit=`, `onchange=`, etc. Use `data-action` attributes with a delegated event listener, or `addEventListener`.
3. **Escaping Rule:**
   - Server-side: All dynamic variables MUST be escaped via `escapeHtml()` or `escapeJson()` from `src/escape.ts`.
   - Client-side: Construct DOM elements and assign `textContent`. Never concatenate values into `innerHTML`.
   - `escapeHtml()` / `escapeAttr()` exist **only on the server**. Calling them from a client script
     (an escaped `\${...}` inside the template) is a runtime `ReferenceError`; the test suite rejects it.
   - URLs: Validate and sanitize via `safeHttpUrl()`.
4. **Primary Rail & Multi-Level Layout Architecture:**
   - Level 1 Rail (72px) has exactly 4 modules: Workstations, Apps & Web, Staff, Settings.
   - Level 2 Action Panel (272px) provides module-specific tools without duplicating navigation.
   - **Declared CSS Classes Only:** Every class rendered in markup MUST be declared in `ui_layout.ts` (e.g. `.table-scrollable`, `.form-checkbox`, `.form-checkbox-label`, `.grid-2col`, `.tab-pane`).
   - Use `.table-scrollable` (`max-height: 480px; overflow-y: auto;`) with sticky `th` for long tables to prevent awkward vertical growth.
   - Wire subpanel buttons using `data-action="tab-<id>"` and integrate with `window.labkioskSwitchTab()`.
   - A panel filter works when the page defines `window.labkioskApplyFilter` (density:
     `window.labkioskApplyDensity`); `renderSubPanelScripts()` disables the control otherwise.
   - Reloading onto a tab replaces `?tab=` (`url.searchParams.set`) rather than appending another.
   - Header counters are filled on every console page, not only on Workstations.
5. **Verify in a browser, not only in tests:** the suite checks markup, not whether a script runs.
   Drive the page (create, move, delete, filter) and read the console for errors.

---

## 2. Automated Verification & Testing

Always execute these commands in order before submitting code changes:

### 1. TypeScript Strict Typecheck
```bash
pnpm --prefix cloudflare-control run typecheck
```
*Expected result:* Exit code 0, zero errors. Typechecks both `src/` (Workers runtime) and `test/` (Node runtime).

### 2. Automated Multi-Tenant & Security Tests
```bash
pnpm --prefix cloudflare-control test
```
*Expected result:* All unit and integration tests passing.

**Testing Mandatory Rule:** When adding any route, you MUST add corresponding negative tests (unauthenticated access, cross-tenant tampering, cross-site `Origin`, invalid input, and — for anything touching staff — a delegate trying to exceed their own permissions).

On a production host a request naming an organization it may not act on (`?tenant=`) is refused with
`403` before the route's own `401` runs, so an anonymous negative test asserts "refused" (`401` or
`403`) rather than one exact status.

### 3. Running Local Development Server
```bash
cd cloudflare-control
cp .dev.vars.example .dev.vars   # One-time setup: configure local secrets
pnpm dev                        # predev applies migrations to local D1
```
