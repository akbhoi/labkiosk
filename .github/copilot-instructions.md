# GitHub Copilot Instructions — Lab Kiosk

These instructions guide GitHub Copilot when assisting contributors on the Lab Kiosk codebase. The full rules are in `AGENTS.md` and the subsystem codices; read the relevant one before changing a subsystem.

## Subsystem Architecture
- **Client OS & Distro (`distro-builder/`)**: Debian 12 Live ISO, Openbox, Python agent (`agent.py`, standard library only, loopback `127.0.0.1:8888`), disk installer (`labkiosk-install`), Manifest V3 extension (`content.js` in Shadow DOM, `background.js` as the only loopback caller). Read `distro-builder/AGENTS.md`.
- **Control Plane (`cloudflare-control/`)**: Cloudflare Workers edge SaaS, D1 database (`migrations/0001..0011` mirrored in `SCHEMA_SQL`), native Web Crypto PBKDF2 authentication, nonce-based CSP. The organization console has four modules (Workstations, Apps & Web, Staff, Settings), one `ui_admin_<page>.ts` per page. Read `cloudflare-control/AGENTS.md`.

## Mandatory Coding Invariants

### Control plane
1. **0 Runtime NPM Dependencies in Worker**: use native `crypto.subtle` (`PBKDF2-HMAC-SHA256`, 100k iterations, 32-byte salt).
2. **Multi-Tenant Filtering**: all queries in `cloudflare-control/src/db.ts` filter by `tenant_id`; state two requests must agree on lives in D1.
3. **Guard every route** from `src/guard.ts` (`resolveTenant()`, `requireTenantAdmin()` / `requireTenantPermission()`, `requireSuperAdmin()`, `requireDevice()`), and add negative tests: anonymous, cross-tenant, cross-site `Origin`, invalid input.
4. **Staff delegation never escalates**: validate roles/permissions against `STAFF_ROLES` / `STAFF_PERMISSIONS`, never store `*`, and call `staffDelegationProblem()` on every staff create/update/delete.
5. **Bound batches**: cap id lists at `MAX_BATCH_TARGETS` (500) and write `IN (...)` lists in `D1_IN_LIST_CHUNK` (90) slices — D1 binds at most 100 parameters.
6. **Two Homes for Database Schema**: a new migration in `cloudflare-control/migrations/` AND the mirror in `SCHEMA_SQL`. Never edit an applied migration.
   A CHECK change on `users`/`tenants` must use the cascade-safe rebuild in `0011_organization_vocabulary.sql`; a plain `DROP TABLE` cascade-deletes every organization.
   Vocabulary is organization / operator / staff / user / User Portal (roles `org_admin`, `operator`, `assistant`; permission `staff`); license statements must match `LICENSE`.
7. **Escape everything**: server-side `escapeHtml()` / `escapeJson()`; client-side DOM nodes with `textContent` — `escapeHtml`/`escapeAttr` are server-only and throw in the browser. URLs go through `safeHttpUrl()`.
8. **No Inline Event Handlers**: CSP disallows `onclick=`, `onsubmit=`, etc. Every `<script>` carries the response nonce; use `data-action` attributes and listeners.
9. **Console API calls use `labkioskApi(path)`**, never bare `fetch("/api/...")`. CSS classes a page renders must be declared in `ui_layout.ts`; colours and radii come from `ui_tokens.ts`.

### Client OS
10. **100% RAM Overlay**: never write dynamic files to disk; `overlayroot="tmpfs:recurse=0"`. Only `LABKIOSK_DATA` at `/etc/labkiosk` persists.
11. **Unattended boot**: never add a password prompt to the normal boot path.
12. **Top-Level Navigation Only**: never load external learning sites inside `<iframe>`.
13. **Installer Output Separation**: in `labkiosk-install`, logs go to `file=sys.stderr`; `sys.stdout` carries only JSON.
14. **Python validation regexes anchor with `\Z`**, never `$`.
15. **Chromium policy**: edit `usr/share/labkiosk/chromium-policy-base.json`; `policies.json` is generated.

### Everywhere
16. **LF line endings** (`.gitattributes`); no placeholders, no empty `catch`/`except`, fail closed on missing configuration.

## Verification Commands
- `pnpm --prefix cloudflare-control run typecheck`
- `pnpm --prefix cloudflare-control test`
- `PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`
- `node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js`
- `node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js`
- `PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m unittest discover -s distro-builder/tests -t distro-builder/tests`
- `python3 distro-builder/tools/generate-chromium-policy.py --check`
