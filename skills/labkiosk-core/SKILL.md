---
name: labkiosk-core
description: Engineering, debugging and verification procedures for Lab Kiosk (Debian 12 kiosk image, Python agent, MV3 extension, Cloudflare Workers + D1 control plane). Use when adding or changing worker routes, templates, schema, the agent, the extension, ISO build hooks, Chromium policy, or when diagnosing multi-tenant routing, CSP, enrolment, telemetry or remote-control problems.
---

# Lab Kiosk Core Engineering Skill

This skill guides AI agents through authoring, modifying, testing, and verifying both the **Debian 12 Client Operating System** and the **Cloudflare Workers Multi-Tenant SaaS Platform**.

> **Co-Development Notice:** This skill and the underlying platform were co-developed through human-AI pair programming (Antigravity by Google DeepMind, then Claude Code). The invariants it relies on are defined in `AGENTS.md`; read that first.

---

## 1. Operating Procedures

### A. Modifying Cloudflare Worker Code
1. Inspect `cloudflare-control/src/types.ts` before editing API contracts.
1b. **Before adding any route**, read `src/guard.ts` and `src/escape.ts`. Every route resolves its
   tenant through `resolveTenant()` and guards access with `requireTenantAdmin()`,
   `requireSuperAdmin()` or `requireDevice()`; every rendered value is escaped. There are no
   exceptions, and the test suite asserts both. Cookie-authenticated mutations already pass the
   CSRF origin check in `index.ts`; do not add routes outside `/api/` that mutate state.
1c. **Before touching a `ui*.ts` template**: every `<script>` carries `nonce="${escapeAttr(nonce)}"`
   and there are no inline `on*=` handlers, only `data-action` attributes with a delegated
   listener (or `addEventListener`). The CSP test renders every page and fails otherwise.
1d. State two requests must agree on goes in D1, never in a module-level variable: the broadcast
   (`tenants.broadcast_url`) and device remote-control details are the precedent.
2. If altering the database schema:
   - Add a **new** numbered migration under `cloudflare-control/migrations/` (never edit an applied one).
   - Mirror the table/index definition in `SCHEMA_SQL` inside `cloudflare-control/src/db.ts`, which is
     what the in-memory adapter builds from. The two must stay in agreement.
   - Ensure all queries filter by `tenant_id`.
3. Verify type-safety (checks worker and test projects separately):
   ```bash
   pnpm --prefix cloudflare-control run typecheck
   ```
4. Run integration tests, and add a negative test for any route you add:
   ```bash
   pnpm --prefix cloudflare-control test
   ```
5. To try it in a browser, `wrangler dev` needs local secrets (there is no default super admin
   once a D1 binding exists) and applies migrations first:
   ```bash
   cd cloudflare-control && cp .dev.vars.example .dev.vars && pnpm dev
   ```
6. **Environment Variables Management**: Never define production secrets or configuration in the `vars` block of `wrangler.jsonc`, as `wrangler deploy` overrides Cloudflare Dashboard settings. Configure production variables (`DEFAULT_DOMAIN`, `ISO_DOWNLOAD_URL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`) directly in the Cloudflare Dashboard / `wrangler secret`, and use `.dev.vars` for local development.

### B. Modifying Client Kiosk Agent & Extension
1. The client agent lives at `distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py`.
   Its local API is loopback-only (`/setup`, `/api/status`, `/api/setup`; there is no nav
   endpoint) and its telemetry is authenticated with a device bearer token. Each heartbeat also
   reports the per-boot VNC password from `/tmp/labkiosk/vnc.secret` and the tunnel hostname from
   `/etc/cloudflared/config.yml` or `LABKIOSK_REMOTE_HOST`, when present. If you add a telemetry
   field, add it to `/api/telemetry` in `index.ts`, `types.ts`, `docs/API.md` and `AGENTS.md`.
1b. Syntax-check before you copy anything into a container (CI runs the same):
   ```bash
   python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
   node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
   node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
   ```
2. The browser injection extension lives at `distro-builder/config/includes.chroot/opt/labkiosk/extension/`.
   It is a Manifest V3 pair: `content.js` builds the nav bar and lock curtain in a shadow root, and
   `background.js` (the service worker) is the only thing that talks to the agent, because a content
   script's `fetch` is subject to the host page's CORS while the service worker runs under
   `host_permissions`.
3. The first-boot setup wizard lives at `distro-builder/config/includes.chroot/opt/labkiosk/setup/wizard.html`.
   It collects the subdomain, workstation name and **enrollment key**; the agent verifies all three
   against the control plane before persisting anything.
4. To test changes immediately without rebuilding the ISO:
   ```bash
   # Copy into running Docker container
   docker cp distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py labkiosk-client-01:/opt/labkiosk/agent/agent.py
   docker cp distro-builder/config/includes.chroot/opt/labkiosk/extension labkiosk-client-01:/opt/labkiosk/

   # Restart Python agent
   docker exec labkiosk-client-01 pkill -f agent.py

   # Extension changes need a browser restart -- an MV3 extension is read once at
   # launch. The watchdog relaunches Chromium within a second.
   docker exec labkiosk-client-01 pkill -f -- --user-data-dir=/tmp/chromium-profile

   # Verify log output
   docker exec labkiosk-client-01 tail -n 20 /tmp/lab-agent.log
   ```

### C. Capturing Visual Screen Verification
Never claim a UI change is complete without inspecting a visual capture. The agent logging a command
as executed proves only that the agent ran; it does not prove the student saw anything:
```bash
# Capture display 0 inside the container
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png

# Copy out to view
docker cp labkiosk-client-01:/tmp/verify.png .
```

---

## 2. Critical Edge Cases & Troubleshooting

### 1. `X-Frame-Options` and `Content-Security-Policy` Blocks
- **Symptom:** Webpage displays "www.khanacademy.org refused to connect" or blank white frame.
- **Root Cause:** Loading modern web applications inside `<iframe>` tags is blocked by modern security headers.
- **Remedy:** Always load educational applications in top-level native browser frames. Rely on the injected Chrome extension (`content.js`) for the top navigation bar and fullscreen lock curtain.

### 2. Chromium Policy Syntax Rules
- **Invalid Pattern:** `http://localhost:*` or `127.0.0.1:*` (Chromium will discard the rule with an `Invalid pattern` error).
- **Valid Pattern:** `localhost` or `127.0.0.1` or `host.containers.internal`. Omission of port matches all ports automatically.

### 3. Miniflare / D1 Multiline SQL Parsing on Windows
- **Symptom:** `D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS ... incomplete input`.
- **Root Cause:** Miniflare's `db.exec()` breaks when parsing multiline strings with Windows CRLF line endings.
- **Remedy:** Always split statements by `;`, normalize newlines with `.replace(/\r\n/g, "\n")`, and execute statements sequentially using `db.prepare(stmt).run()`.

### 4. Chromium Root Execution in Docker
- **Symptom:** `Running as root without --no-sandbox is not supported`.
- **Remedy:** Pass `--no-sandbox` **only** in `docker-test/entrypoint.sh`, where Chromium runs as root
  inside the container. The real image keeps the sandbox enabled, and must never be launched with
  `--disable-web-security`.

### 5. Schema Drift Between the Adapter and Migrations
- **Symptom:** `Columns of "x" differ between SCHEMA_SQL and migrations/`.
- **Cause:** A schema change landed in only one of the two places that declare it.
- **Remedy:** Add a new numbered file under `migrations/` **and** make the matching edit to
  `SCHEMA_SQL` in `src/db.ts`. Never edit an already-applied migration.

### 6. Build Pins Are Not Optional Defaults
- `cloudflared.pin` and `grub.pin` under `config/includes.chroot/usr/share/labkiosk/` hold values that
  cannot be verified from the repository: a release checksum and a boot-password hash.
- An unset checksum builds without the tunnel binary; a bad one **fails the build**. An unset GRUB
  password builds with a loud warning. Never invent a value to make a build go green.

### 7. Chromium Refuses the Kiosk's Own Extension
- **Symptom:** No navigation bar, no lock curtain. Chromium logs *"Loading of unpacked extensions is
  disabled by the administrator"*.
- **Cause:** A blanket extension block in the managed policy — `ExtensionInstallBlocklist: ["*"]`, or
  `ExtensionSettings` with a `"*"` deny. It makes Chromium refuse `--load-extension` outright, and an
  `ExtensionInstallAllowlist` entry for the kiosk's own id does **not** override it. This was tried
  and verified.
- **Remedy:** Do not add a blanket block. Students cannot install extensions anyway: `chrome://` is in
  `URLBlocklist`, the browser runs in `--kiosk` with no UI, the Web Store is not allowlisted, and
  `/tmp/chromium-profile` is deleted on every launch. If a blanket block is ever genuinely required,
  pack the extension as a `.crx` and force-install it by id first.

### 8. Freshly Enrolled Workstation Shows "This page is blocked"
- **Symptom:** Enrolment succeeds, the dashboard shows the workstation, but its screen is a Chromium
  block page instead of the school portal.
- **Cause:** Chromium reads its managed policy at startup. A workstation that enrolled after launch is
  still running under the minimal boot allowlist.
- **Remedy:** The agent sets `pendingBrowserRestart` at enrolment and restarts the browser after the
  next policy sync. `BROWSER_PROFILE_DIR` in `agent.py` must match `--user-data-dir` in both
  launchers, because the restart works by `pkill -f -- --user-data-dir=<dir>` — matching on
  `"chromium --kiosk"` silently matches nothing, since the Debian wrapper reorders the argv.

### 9. A Command Executes but Nothing Changes on Screen
- **Symptom:** `/tmp/lab-agent.log` records the lock, the curtain never appears, and the nav bar's
  status dot still looks green.
- **Cause:** The dot is green by default in CSS. It once stayed green for a whole session in which no
  poll had ever succeeded, because `initKioskUi()` returned `undefined` when the UI already existed
  and the caller assigned that over a working `shadowRoot`.
- **Remedy:** Treat a screenshot, not a log line and not a status colour, as the evidence a UI change
  works. Check the agent's `/api/status` from inside the container if the extension looks alive but
  inert.

### 10. Workstation Not Appearing on the Dashboard
- **Symptom:** The agent logs `401` responses, or the grid stays empty after boot.
- **Cause:** The workstation is not enrolled, or its device token was revoked when a teacher removed
  it from the dashboard. A `403` means the school itself is suspended or not yet active.
- **Remedy:** Re-run the setup wizard with the school's current enrollment key
  (**Settings -> Workstation Enrollment Key** on the teacher dashboard). Check `/tmp/lab-agent.log`.
  Repeated wrong keys from one address answer `429` for a while; wait or use the right key.

### 11. A Console Button Does Nothing, Console Shows a CSP Error
- **Symptom:** "Refused to execute inline event handler" or "Refused to execute inline script".
- **Cause:** A template gained an `on*=` attribute, or a `<script>` without the response nonce.
- **Remedy:** `data-action` + delegated listener, and `nonce="${escapeAttr(nonce)}"` on the script.
  Run the test suite; it renders every page and reports the exact offending tag.

### 12. Worker Refuses to Start
- **`SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set`:** there is no default super
  admin once a D1 binding exists. Locally `cp .dev.vars.example .dev.vars`; deployed, set both
  Wrangler secrets.
- **`The D1 database is missing the current schema`:** run
  `wrangler d1 migrations apply labkiosk-db --remote` (or `--local`). The worker never creates
  tables on a bound database, because that shape blocks later `ALTER TABLE` migrations.

### 13. "Remote Control" Cannot Connect
- **Symptom:** The noVNC frame asks for a password, or never connects.
- **Cause:** The workstation has not sent a heartbeat since boot (no `vncPassword` yet), or it has
  no Cloudflare Tunnel, so there is no `remoteHost` and nothing answers at `<pc>.<TUNNEL_DOMAIN>`.
- **Remedy:** Check `/api/clients` for `vncPassword` and `remoteHost` on that device. Provision a
  per-workstation tunnel (`docs/REMOTE_CONTROL.md`); in the simulator set
  `LABKIOSK_REMOTE_HOST` to a hostname that reaches port 6080.

### 14. Custom Domain Edge-Routing and Dynamic Whitelisting
- **Symptom:** Accessing the platform via an approved custom domain (e.g. `kiosk.institution.edu`) loads the SaaS landing page instead of the student portal, or kiosks show "This page is blocked".
- **Root Cause:** In `index.ts`, custom domain hosts matched `!namedTenant && !onSubdomain` and fell through to the public landing page unless `isCustomDomainHost` is checked. Additionally, Chromium clients will block the portal unless `tenant.custom_domain` is explicitly included in the policy allowlist.
- **Remedy:** In `index.ts`, check `isCustomDomainHost` matching `hostname(request) === currentTenant.custom_domain.toLowerCase()` when deciding `wantsPortal`. In `db.ts`, `buildEffectiveWhitelist()` automatically includes `tenant.custom_domain`.

### 15. Cloudflare Dashboard Environment Variables Overwritten on Deploy
- **Symptom:** Environment variables configured in the Cloudflare Dashboard (e.g. `DEFAULT_DOMAIN`, `ISO_DOWNLOAD_URL`) revert or disappear after running `wrangler deploy`.
- **Root Cause:** Defining a `vars` block in `wrangler.jsonc` overrides the hosted environment variables on Cloudflare.
- **Remedy:** Omit `vars` from `wrangler.jsonc`. Rely on Cloudflare Dashboard settings for hosted environments and `.dev.vars` for local development.
