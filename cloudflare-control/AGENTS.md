# LabKiosk Cloudflare Control Plane — AI Agent Codex

> **Scope:** This document is the authoritative architectural specification and coding standard for the **Cloudflare Workers Control Plane**, Cloudflare D1 database, Web Crypto authentication, edge routing, multi-tenant scoping, and HTML/UI generation.
> For the client Debian 12 operating system and installer, refer to [`distro-builder/AGENTS.md`](../distro-builder/AGENTS.md). For the global invariants, see the root [`AGENTS.md`](../AGENTS.md); the client ↔ Worker contracts (telemetry, enrolment, commands, broadcast state, remote control) are in [`.agents/skills/labkiosk-core/SKILL.md`](../.agents/skills/labkiosk-core/SKILL.md).

---

## 1. System Architecture Map

```text
cloudflare-control/
├── migrations/                         # Cloudflare D1 SQL migrations (0001..0012)
├── .dev.vars.example                   # Local secrets template for `wrangler dev`
├── wrangler.jsonc                      # Routes, D1 binding, hourly cron trigger
├── src/
│   ├── index.ts                        # Edge router, REST APIs, telemetry cache, scheduled()
│   ├── guard.ts                        # Tenant resolution, authorization, CSRF origin guard (MANDATORY)
│   ├── escape.ts                       # HTML / attribute / JSON escaping & safe URLs (MANDATORY)
│   ├── db.ts                           # D1 Database queries, SCHEMA_SQL & tenant seeding
│   ├── auth.ts                         # Native Web Crypto PBKDF2 authentication, CSP nonces
│   ├── d1_adapter.ts                   # Node 22+ native `node:sqlite` mock for local unit tests
│   ├── ui.ts                           # Organization admin console: picks the page, fills the shell
│   ├── ui_admin_shared.ts              # Tenant API scope + Level 2 context panel behaviour
│   ├── ui_admin_workstations.ts        # One module per admin page (Rule 5f): its markup, its
│   ├── ui_admin_apps_web.ts            #   context panel and its client script together.
│   ├── ui_admin_staff.ts               #   apps_web unifies broadcasts, portal apps and
│   ├── ui_admin_settings.ts            #   the domain allowlist in three tabs
│   ├── ui_tokens.ts                    # The one declaration of the design language: colours,
│   │                                   #   radii and easing, plus the legacy aliases the public
│   │                                   #   pages were written against
│   ├── ui_layout.ts                    # Shared shell: 72px rail, 272px context panel, primitives
│   ├── ui_landing.ts                   # Public SaaS Landing Page
│   ├── ui_org_home.ts                  # The organization homepage at the subdomain root (/)
│   ├── ui_portal.ts                    # User Portal at /home (cards grid)
│   ├── ui_super.ts                     # Super Admin Master Console (/super)
│   ├── ui_legal.ts                     # Legal compliance pages (/privacy, /terms)
│   └── types.ts                        # Strict TypeScript interfaces
└── test/
    ├── worker.test.ts                  # Multi-tenant automated integration & security test suite
    ├── dump_admin_html.ts              # Renders the four console pages from fixed inputs (Rule 5f)
    └── dev_server.ts                   # Runs the worker under Node on the in-memory database
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
- **Nothing that two requests must agree on lives in module memory.** The active broadcast (`tenants.broadcast_url` / `broadcast_epoch` organization-wide, `client_devices.broadcast_url` / `broadcast_epoch` per workstation) and a workstation's remote-control details (`client_devices.vnc_password` / `remote_host`) are rows in D1.
- **Subdomain Routing & Apex Redirection**: Organization admin dashboards are located at `/admin` on their own subdomain (`https://<subdomain>.<baseDomain>/admin`). Accessing `/admin` on the base apex domain redirects (302) to the authenticated organization admin's subdomain `/admin` (or `/super` for super admins). When a super admin accesses a specific organization admin sub-route (`/admin/workstations`, `/admin/broadcast`, etc.) on apex or dev without a query param, it routes to the `demo` organization console (`?tenant=demo`) rather than bouncing to `/super`. Furthermore, whenever a console is rendered outside its dedicated subdomain (e.g. On apex or dev hosts), all internal navigation links preserve `?tenant=<subdomain>` to maintain session context.
- **Super Admin Privacy Isolation**: Super admins are strictly restricted from accessing any organization's admin console (`/admin`), workstation telemetry, or remote desktop/VNC channel *except* for the dedicated `demo` organization tenant. Super admin privileges permit approving custom domains, managing interface catalogs, and system maintenance, but protect each organization's privacy. Full access permissions (`*`) are guaranteed for super admins on the `demo` tenant.
- **Granular Staff Delegation & Sub-admins**: Organization admins can delegate management functions by creating staff accounts (`tenant_users` table) with roles (`org_admin`, `sub_admin`, `operator`, `assistant`, `content_manager`) and granular permissions (`workstations`, `broadcast`, `portal`, `whitelist`, `staff`, `settings`). Both are validated against those lists on the way in; `*` is never stored.
- **Delegation Never Escalates**: a staff member holding `staff` who is not a co-administrator may only grant permissions they hold, may not appoint an `org_admin`, and may not change or remove their own account or a co-administrator's (`staffDelegationProblem()` in `index.ts`). Adding staff refuses an email that already has an account (`409`) rather than linking another organization's user, and removing staff ends that account's sessions.
- **Customizable Subdomain & Settings**: Organization admins can customize their subdomain (`POST /api/tenant/subdomain`), default home route (`home_route`: e.g. `/` vs `/home`), and tunnel domain (`tunnel_domain` for per-organization Cloudflare Tunnels).
- **Never resolve a tenant by hand.** Call `resolveTenant()` in `guard.ts`. The `Host` header is authoritative; `?tenant=` / `X-Tenant` are honoured only on a local dev host, for a super admin (restricted to `demo`), for a session that already owns that tenant, or on an explicitly public route.
- **Never write a route without a guard.** Every endpoint that reads or changes an organization's data calls `requireTenantAdmin()` or `requireTenantPermission()`; platform endpoints call `requireSuperAdmin()`; `/api/telemetry` calls `requireDevice()`. A route with no guard is a security vulnerability.
- A workstation's identity comes from its device token, never from the request body. `/api/telemetry` must ignore any `clientId` or tenant the payload claims.
- Only the `Host` header says where a request arrived. Never read `X-Forwarded-Host` (or any other caller-supplied header) to build a URL that is handed back to a workstation.

### Rule 2b: Interface Catalogs Are Platform Assets, Not Tenant Data

- `ui_catalogs` holds the translated interface text for the wizard and the kiosk top bar. It has no
  `tenant_id` and must not grow one: the product says the same thing to every organization, and a
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

### Rule 2c: Workstation Groups & Batch Command Architecture

- **Workstation Groups Table (`workstation_groups`)**: Tenants can organize client devices into named groups (e.g. "Row 1", "Lab A", "Physics"). Devices link via `client_devices.group_name`.
- **Management Endpoints**:
  - `GET /api/groups`: List workstation groups for the tenant.
  - `POST /api/groups`: Create a new group (`{ name }`, 1–50 characters). Names are unique per
    organization, compared case-insensitively (`409` otherwise): membership is stored **by name**, so two
    groups sharing one would share members and deleting either would ungroup both. A unique index
    (`0012`) enforces it too, so two requests at once cannot both create the same name.
  - `DELETE /api/groups/:id`: Delete group and set member devices' `group_name` to `NULL` in one
    `db.batch()`; `404` for a group this organization does not have.
  - `POST /api/clients/group`: Assign devices to a group (`{ clientIds: string[], groupName: string | null }`).
    `groupName` must be an existing group (`404`), or empty/`null` to ungroup.
- **Batch Command Dispatch (`POST /api/command`)**:
  - Accepts `targets: string[]` (or legacy single `target: string`). Duplicates are dropped and
    `"all"` replaces any named targets, so a broadcast is queued once.
  - Iterates targets and enqueues commands for each device, returning `{ status: "ok", count, commandIds }`.
- **A broadcast is recorded where it was addressed** (migration `0010`). `"all"` writes the tenant
  row; a list of workstations writes each one's `client_devices.broadcast_url` / `broadcast_epoch`.
  A reset is recorded as `NULL` with its own epoch, never erased. The heartbeat hands each
  workstation the newer of the two (read back from the upsert with `RETURNING`, no extra query).
  Recording only the `"all"` case is what sent a broadcast to selected screens back to the portal
  on the very next heartbeat, and let a subset reset clear everyone's broadcast.
- **Bounded batches**: at most `MAX_BATCH_TARGETS` (500) ids per request on both routes. D1 binds at
  most **100 parameters per statement**, so any `IN (...)` list is written in slices of
  `D1_IN_LIST_CHUNK` (90). An unbounded list is both a denial-of-service lever and a query that
  fails outright past ~97 ids.

### Rule 3: The Schema Has Two Homes

- `migrations/` is what a deployed D1 database has; `SCHEMA_SQL` in `db.ts` builds the in-memory database that tests and local development use. Both must be changed together.
- Add a **new** numbered migration file (e.g. `0006_feature.sql`); **never** edit an applied migration.
- `test/worker.test.ts` compares the two schemas and fails on drift — column names, and, on the real
  SQLite engine, types, NOT NULL, defaults, primary and foreign keys, indexes (UNIQUE included) and
  CHECK constraints. The column-only check missed that `SCHEMA_SQL` had `idx_tenants_custom_domain`
  non-unique while production had it UNIQUE.

### Rule 3b: Rebuilding a Parent Table Must Never Cascade

- D1 cannot switch foreign keys off, and `DROP TABLE` deletes the table's rows first — which fires
  `ON DELETE CASCADE` even under `PRAGMA defer_foreign_keys = true`. Rebuilding `users` (or `tenants`)
  in place deletes every organization and session. This was demonstrated, not assumed.
- A CHECK or column-definition change on a parent table therefore follows `0011_organization_vocabulary.sql`:
  hold every affected row in `_hold_<t>` tables (`CREATE TABLE … AS SELECT`, no foreign keys), drop
  **leaves first**, recreate **parents first**, copy back with **explicit column lists** (production
  column order differs from `SCHEMA_SQL`), then drop the holding tables. Wrangler applies the file as
  one unit.
- Every such migration ships with a test that builds the database from the earlier migrations, seeds
  every affected table, applies it, and asserts identical row counts and an empty
  `PRAGMA foreign_key_check`. Export the production database first:
  `wrangler d1 export labkiosk-db --remote --output backup.sql`.

### Rule 3c: The Product Is for Any Organization

- Lab Kiosk serves companies, public bodies, libraries and schools alike. The tenant is an
  **organization**; its roles are `org_admin`, `sub_admin`, `operator`, `assistant` and
  `content_manager`; the staff permission is `staff`; the console's modules are Workstations,
  Apps & Web, Staff and Settings; the launcher is the **User Portal**. Migration `0011` renamed the
  stored values (`school_admin`, `teacher`, `lab_assistant`, `teachers`).
- A test renders every console page, the User Portal and the organization homepage and fails on
  "school", "teacher", "student", "lesson", "classroom" or "instructor". The landing page (which has
  an Education audience) and the legal pages are exempt.
- **Kept on purpose:** applied migrations `0001`–`0010` (never edited, and wrangler tracks them by file
  name); the interface-catalog keys `ui.classroom-workstation-setup`,
  `ui.i-understand-continue-to-the-lesson`, `ui.school-http-https-proxy-optional`,
  `ui.institution-subdomain` and the two `…-institution-edu` placeholders (translations already use
  them; only their English values changed); and `schoolName`, still sent beside `organizationName` in
  the enrolment and `/api/status` replies for agents installed before the rename.
- **Statements about the license describe the license.** `LICENSE` grants free use only to accredited
  educational institutions and non-commercial evaluation, up to 45 computers; everyone else needs a
  commercial or subscriber license. Never generalize those sentences to "organizations".

### Rule 4: Escape Everything Rendered & Safe URLs

- Tenant data is attacker-controlled: organization names, admin emails, portal card titles, and URLs arrive through registration or the admin console.
- Server-side, every interpolation into a `ui*.ts` template goes through `escapeHtml()` / `escapeJson()` from `escape.ts`. `escapeJson()` is required for anything inlined into a `<script>` block.
- Client-side, build DOM nodes and assign `textContent`. Never concatenate a value into `innerHTML`, and never place one inside an inline `onclick=` attribute — attach listeners and pass ids through `dataset`.
- **`escapeHtml()` / `escapeAttr()` do not exist in the browser.** Inside a template's client script
  (`\${...}` escaped in the TypeScript string) a call to them is a `ReferenceError` at runtime — the
  workstation group list crashed on every refresh that way. Use `el()` / `textContent` / `dataset` /
  `new Option()` and `replaceChildren()`. A test fails if any console script contains either name.
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

- The dashboard control planes (both Organization Admin `/admin/*` and Super Admin `/super/*`) use a unified **Left-Side Multi-Level Panels Architecture**:
  - **Level 1 (Primary Rail — 72px)**: Slim, persistent vertical bar with the brand icon, exactly 4 primary module icons (Workstations, Apps & Web, Staff, Settings), live stats counter, bottom-left interactive profile avatar button with anchored popover menu (user details, role badge, password/settings shortcut, and POST sign-out), and panel expand/collapse toggle.
  - **Level 2 (Secondary Action Panel — 272px)**: Context-aware sub-panel that expands seamlessly with hardware-accelerated CSS (`transform: translateX()`, `opacity`, `cubic-bezier(0.16, 1, 0.3, 1)`), providing module-specific tools, live filters, and batch commands. Subpanels strictly provide contextual tools and never duplicate the Level 1 Rail navigation (no redundant "Quick Navigation" or "Back to Workstations" lists).
  - **Workstations Page Layout (`/admin/workstations`)**:
    - **Sidebar Subpanel**: Removed duplicate batch commands. Dedicated to Workstation Groups management (`+ New Group`, member counts, filtering by group, and delete group actions).
    - **Top Toolbar**: Contains "Select All" toggle checkbox, dynamic selection count indicator (`# selected`), targeted batch actions (`Lock`, `Unlock`, `Clear Session`, `Reboot`, `Shutdown`), `Move to Group...`, `Reset to Portal`, and `Broadcast URL`.
    - **Main Viewport**: Workstations are partitioned into collapsible `.group-section` containers with header chevrons and group selection checkboxes, saving collapse states in `localStorage`.
  - **Consolidated "Apps & Web" Module (`/admin/apps-web`)**:
    - Unifies Broadcast, User Portal Apps, and Domain Allowlist into a single, cohesive view with 3 tab panes (`Broadcast`, `User Portal Apps`, and `Domain Allowlist`), with deep linking via `?tab=...` and instant client-side tab switching (`history.replaceState`). Legacy paths (`/admin/broadcast`, `/admin/portal`, `/admin/whitelist`) 302-redirect to `/admin/apps-web?tab=<tab>`.
    - **Stabilized Sidebar Subpanel**: Fixed, non-shifting Level 2 subpanel featuring static tab view switchers (`📶 Broadcast`, `⊞ User Portal`, `🛡️ Domain Allowlist`), a `Preview User Portal &rarr;` shortcut opening `/home` in a new tab, and a static Module Overview card (total apps, allowed domains, live broadcast status). Eliminates dynamic layout shift.
    - **Cleaned Main Tabs**: Context formerly trapped in the subpanel was migrated directly into the relevant main tabs. Removed redundant "Standard Educational Presets" from Broadcast to prevent duplicate lists.
  - **Staff Page Layout (`/admin/staff`)**:
    - **Sidebar Subpanel**: Active **"Role"** filter section (`All Roles`, `Operator`, `Assistant`, `Content Manager`, `Co-Administrator`, plus dynamic roles) with live count badges that filter the authorized operators table instantly without page reload.
    - **Standard Accessible Checkboxes**: Uses styled `.form-checkbox` and `.form-checkbox-label` components with clean SVG checkmark tick mark, dark theme palette, hover highlights, and focus rings. Role dropdown preselects corresponding permission checkboxes automatically.
  - **Settings Page Layout (`/admin/settings`)**:
    - **Semantic Tab Panes**: Converted 9 fragile vertical scroll jumps into 4 distinct semantic tab panes (`General & Kiosk`, `Domains & Network`, `Organization Homepage`, `Security & Audit`) with instant client-side switching and deep linking (`?tab=...`).
    - **Horizontal Card Grouping (`grid-2col`)**: Organizes related configuration cards side-by-side (Organization Profile & Kiosk Mode \| Kiosk Routing & Home URL; Subdomain & VNC Tunnel \| Custom Domain; Homepage Identity \| Content Blocks; Enrollment Key & Admin Password \| Recent Activity).
    - **Scrollable Activity Table (`.table-scrollable`)**: Recent Activity table is constrained with `.table-scrollable` (`max-height: 480px; overflow-y: auto;`) with sticky pinned table headers (`th` with `position: sticky; top: 0; z-index: 2;`) and thin scrollbars, keeping the card compact and neatly aligned with the left column.
  - **Content Area & Clean Top Header**: Fluid layout adapting smoothly to panel states without content jumping. The top canvas header is kept clean and minimal, displaying solely breadcrumbs and telemetry counters; profile and sign-out controls strictly reside in the bottom-left avatar menu.
  - **Transitions & Micro-Interactions**: Hardware-accelerated transitions, 2026 CSS tokens, dark glassmorphism surfaces (`backdrop-filter: blur(12px)`), accessible contrast (WCAG 2.2 AA), and zero inline event handlers (`data-action` pattern).

### Rule 5c: One Design Language, Declared Once

- **`src/ui_tokens.ts` is the only place a colour, radius, easing curve or panel
  width is defined.** Every surface renders its `:root` from `rootTokensCss()` and
  its typography from `FONT_LINKS`. Never open a second `:root` block in a `ui*.ts`
  file.
- This rule exists because the four surfaces each used to carry their own: the
  consoles on `#080c14`, the landing page and the portal on `#090d16` with a
  different border grey, and the legal pages on a third set declared twice in one
  file. Near-miss values are what make one product look like four.
- `LEGACY_*_ALIASES` map the older variable names (`--bg`, `--panel`, `--muted`,
  `--green`) onto the canonical ones so the existing rules in `ui_landing.ts`,
  `ui_portal.ts` and `ui_legal.ts` keep working. New CSS uses the canonical names.
- **A class a page renders must be a class the shell declares.** `input-field` was
  used fourteen times and declared nowhere, so those inputs rendered as white
  browser defaults inside a dark console for as long as they existed. A test
  renders every console page and fails on any class the stylesheet does not carry
  (including `.table-scrollable`, `.form-checkbox`, `.form-checkbox-label`, `.grid-2col`, `.tab-pane`).
- `--text-subtle` is `#808fa6` and not a darker slate because the section headings
  it paints have to clear 4.5:1 against `--bg-panel`, `--bg-surface` and
  `--bg-card`. The WCAG 2.2 AA claim in Rule 5b is only true while it does.

### Rule 5d: The Context Panel Is Wired, Not Decorative

- Every control the Level 2 panel renders does something. It shipped as markup
  only once: `data-filter`, `data-action`, `data-preset` and `data-quick-domain`
  were read by nothing, the three "Add ..." shortcuts pointed at element ids that
  did not exist, the five settings jump links pointed at sections that did not
  exist, and the four telemetry counts never moved off the zero they rendered with.
  That is roughly thirty dead controls in the product's most-used surface.
- `renderSubPanelScripts()` in `ui_admin_shared.ts` owns the behaviour and is emitted on every
  admin page. A panel control is a `data-` attribute that function reads, or it does
  not go in the panel.
- A command the panel triggers delegates to the page's own button rather than
  re-implementing the call, so there is one code path per action. Where the page
  has no such button, the panel navigates to the page that does.
- Whether a `data-filter` / `data-density` control is disabled is decided by **what the page
  provides** (`window.labkioskApplyFilter` / `window.labkioskApplyDensity`), never by which page
  it is. Keying it on "not the workstations page" silently disabled the Operators role filter.
- The header counters (`stat-online-count`, `stat-total-count`, `stat-locked-count`) are real on
  every page: the workstations grid updates them from its own poll, and `renderSubPanelScripts()`
  polls `/api/clients` every 15 s everywhere else, hiding them for a caller refused `workstations`.

### Rule 5e: The Tenant Rides Along on a Dev Host

- Client-side calls go through `window.labkioskApi(path)`, never bare `fetch("/api/...")`.
- In production the organization is its own subdomain and the `Host` header resolves the
  tenant. On `localhost` / `127.0.0.1` there is no subdomain, the tenant travels as
  `?tenant=<slug>`, and a call without it answers `400 No organization selected` -- which
  is what made the entire dashboard untestable with `pnpm dev`.
- Whether this is a dev host is a property of the **request** (`isDevHost()` in
  `guard.ts`, passed to the renderer as `isDevHost`), never of the configured
  `DEFAULT_DOMAIN`: that is `labkiosk.akbhoi.com` in local development too.
- Loopback and RFC 1918 addresses count as dev hosts, because `pnpm dev` listens on
  `0.0.0.0` and the simulator reaches it by LAN address. A deployed worker never sees
  such a `Host` (Cloudflare routes only configured hostnames), which is what keeps that
  safe; do not widen it to anything a public request could carry.

### Rule 5f: One Module Per Admin Page

- A page of the organization console owns its markup, its context-panel contents and
  its client script in one `ui_admin_<page>.ts`, exported as a single
  `build<Page>Page(options): AdminPageParts`. `ui.ts` picks the builder and
  fills the shell; it renders nothing itself.
- This is not tidiness. All six panels used to live in one switch in a
  2,450-line module, hundreds of lines from the handlers meant to read them,
  and that distance is precisely why thirty dead controls sat there unnoticed.
- `ui_admin_shared.ts` holds only what every page needs: `renderApiScopeScript`
  (Rule 5e) and `renderSubPanelScripts` (Rule 5d).
- `test/dump_admin_html.ts` renders all four pages from fixed inputs. Diff its
  output across a refactor of these modules; the split that created them was
  verified byte-for-byte that way.

### Rule 5g: Three Paths on a Organization Host, Each With One Job

- `/` is the **organization homepage**: a headline, an introduction and the content
  blocks the organization publishes, rendered by `ui_org_home.ts`. It is the page
  an organization puts its own name on, and the only one a visitor sees first.
- `/home` is the **user app grid** (`ui_portal.ts`), the launcher a user
  picks a site from.
- `/admin` is the **organization console**, and `/admin/<page>` its sub-pages.
- `/portal` no longer exists. All three paths used to render the same grid,
  which is why `home_route` could be set to any of them. An organization that had
  pointed its workstations at `/portal` would have had them reset to a 404, so
  migration 0008 moves those to `/home` and the option is gone from Lab
  Settings. **Never add a fourth alias**: every one of them is somewhere a
  workstation can be pinned, and removing it later breaks rooms.
- Single-site lockdown outranks both public paths: an organization in `single_url`
  mode redirects to its locked site from `/` and `/home` alike.
- Homepage text is organization-supplied and rendered to users. It is normalised
  and size-capped on the way in (`sanitizeHomepageBlocks`), escaped on the way
  out, and a block link goes through `safeHttpUrl()` on both sides -- neither
  side may assume the other did it.

### Rule 6: State-Changing Requests Prove Their Origin

- Cookie-authenticated `POST`/`DELETE` calls under `/api/` pass `rejectCrossSiteMutation()` in `guard.ts`: a browser-supplied `Origin` must be this host or the platform domain. A dev-host origin (`localhost`, ...) is accepted **only when the request itself is on a dev host**; in production it would admit any page served from the operator's own machine. Bearer-authenticated device routes are exempt.
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
| **A form inside the console renders as a white box with black text** | The markup used a class the shell never declared (`input-field`). An undeclared class styles nothing, so the control falls back to the browser default. | Use `.form-input` / `.form-select` / `.form-textarea` from `ui_layout.ts`. A test renders every console page and fails on any class the stylesheet does not carry. |
| **A control in the left context panel does nothing** | Its `data-` attribute is not one `renderSubPanelScripts()` reads, or its target element id does not exist on that page. | Add the case to that function, or take the control out. See Rule 5d. |
| **Every dashboard API call answers `400 No organization selected` under `pnpm dev`** | The call was written as a bare `fetch("/api/...")`. There is no organization subdomain on a dev host, so nothing resolves the tenant. | Call `labkioskApi(path)`. See Rule 5e. |
| **A page looks subtly off-brand next to the consoles** | It declared its own `:root`. Four surfaces each had one, on four different backgrounds. | Render `:root` from `rootTokensCss()` in `ui_tokens.ts`. See Rule 5c. |
| **A `/super` tab shows another tab's content** | All four panes were emitted together and hidden with an inline `display`, and `.tab-pane` had no CSS at all -- so the pane without an inline rule rendered everywhere. | Render one pane. `panesByTab[activeTab]` in `ui_super.ts` is the only thing that reaches the page. |
| **Resetting Broadcast lands on SaaS landing page instead of organization portal** | `resetBroadcastToPortal()` sent `origin + "/"` without tenant scoping. | Authoritatively resolve `portalUrlFor(tenant)` in `POST /api/command`. |
| **Single-Site Lockdown URL rejected without scheme** | URL lacked `https://` prefix (e.g. `canvas.example.com`). | `safeHttpUrl()` in `escape.ts` automatically prepends `https://` for scheme-less domains. |
| **Cloudflare Dashboard env vars overwritten on deploy** | Defining `vars` in `wrangler.jsonc` overrides Cloudflare dashboard variables. | Omit `vars` block from `wrangler.jsonc`. Manage production secrets via Cloudflare Dashboard / `wrangler secret`. |
| **Creating a workstation group does nothing; console logs `escapeAttr is not defined`** | The client script rebuilt the group list by calling the server-only `escapeHtml`/`escapeAttr` inside an escaped `\${...}`. | Build nodes with `el()`/`textContent`/`dataset`/`new Option()`. A test rejects either name in any console script. |
| **The Operators role filter is greyed out** | `renderSubPanelScripts()` disabled every `data-filter` on pages other than Workstations. | Disable a panel control only when the page defines no handler for it (`window.labkioskApplyFilter`). |
| **An operator with the staff permission becomes a co-administrator** | Staff routes stored any role and any permission string, `*` included, and let a delegate edit their own row. | `STAFF_ROLES` / `STAFF_PERMISSIONS` validation plus `staffDelegationProblem()` on create, update and delete. |
| **Moving ~100+ workstations to a group fails** | D1 binds at most 100 parameters per statement and the `IN (...)` list was built in one go. | Cap at `MAX_BATCH_TARGETS` and write in `D1_IN_LIST_CHUNK` slices. |
| **A broadcast to selected workstations reverts to the portal after 2–3 seconds** | Only a broadcast to `"all"` was stored (on the tenant); a list of ids only queued a command, and the next heartbeat's `targetUrl` sent the screens back. | Record per workstation on `client_devices` (migration `0010`); the heartbeat serves the newer of organization-wide and per-workstation. |
| **Online / Total read 0 everywhere except the grid** | Only the Workstations page polled telemetry. | `renderSubPanelScripts()` polls `/api/clients` on the other pages. |
