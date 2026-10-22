# Production Deployment

Deploying the control plane to Cloudflare Workers with D1, secrets, wildcard DNS, and CI/CD.

You deploy the control plane **once**; it serves every organization. The client OS is deployed per workstation — → [Installation Guide](Installation-Guide).

---

## Prerequisites

1. A Cloudflare account with Workers and D1 enabled.
2. A domain managed in Cloudflare (e.g. `yourdomain.com`).
3. Node.js v22+ and pnpm v9+.
4. Wrangler authenticated: `npx wrangler login`.

---

## 1. Provision D1

```bash
cd cloudflare-control
npx wrangler d1 create labkiosk-db
```

```text
✅ Successfully created DB 'labkiosk-db'
{
  "binding": "DB",
  "database_name": "labkiosk-db",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Paste the `database_id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "labkiosk-db",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "migrations_dir": "migrations"
  }
]
```

Apply the schema:

```bash
npx wrangler d1 migrations apply labkiosk-db --remote
```

> **This is not optional.** `assertSchemaCurrent()` refuses to serve a bound database whose migrations have not been applied, and a deployed worker never creates tables at runtime. → [Database Schema](Database-Schema)

### Upgrading an existing deployment

Pending migrations are applied the same way. Two of them change existing data:

- **`0010_workstation_broadcast.sql`** adds per-workstation broadcast state. Deploy the Worker in the
  same release: the new Worker reads these columns on every heartbeat.
- **`0011_organization_vocabulary.sql`** renames the stored roles (`school_admin` → `org_admin`,
  `teacher` → `operator`, `lab_assistant` → `assistant`) and the staff permission (`teachers` →
  `staff`) by rebuilding every table that references `users`. It is written to be cascade-safe and
  is applied as one unit, but it rewrites your core tables, so **export the database first**.
- **`0012_unique_workstation_group_names.sql`** makes group names unique per organization in the
  database (case-insensitively). If an organization already has two groups spelled the same way,
  they are merged into the oldest one and its member workstations keep their group.
- **`0013_retire_demo_tenant.sql`** **deletes the old `demo` organization and everything in it** —
  its workstations, device tokens, apps, allowlist, presets, groups, staff links and audit history.
  It is replaced by three demo organizations the worker creates at startup: `web-demo` (the hosted
  site), `local-demo` (a local VM) and `docker-demo` (the Docker simulator). Re-enrol any demo
  workstations into `web-demo` afterwards. Before deploying, check nobody already holds one of the
  new names — a row there not owned by the super admin is left alone and is not a demo:
  `npx wrangler d1 execute labkiosk-db --remote --command "SELECT subdomain, user_id FROM tenants WHERE subdomain IN ('web-demo','local-demo','docker-demo')"`
- **`0015_workstation_boot_reports.sql`** to **`0018_bug_report_triage.sql`** are additive and must
  all be applied before the Worker that uses them is deployed: `0015` adds the boot-report columns
  on `client_devices` (`image_version`, `update_state`, `update_error`, `update_state_at`), `0016`
  the `workstation_issues` table behind Settings → Errors & Warnings, `0017` and `0018` the opt-in,
  terms acceptance and triage state of automatic bug reports. Without them `assertSchemaCurrent()`
  refuses to serve.

Back up, apply, then deploy:

```bash
npx wrangler d1 export labkiosk-db --remote --output labkiosk-backup.sql
npx wrangler d1 migrations apply labkiosk-db --remote
npx wrangler deploy
```

D1 Time Travel is a second safety net (`wrangler d1 time-travel restore labkiosk-db --timestamp=<before>`).
Admin sessions survive the migration; anyone with a console tab open should reload it. Workstations
installed from an older ISO keep working: the Worker still sends `schoolName` alongside
`organizationName`.

---

## 2. Set the super-admin secrets

Production **fails closed** without them. There is no default administrative credential anywhere in the production path.

```bash
npx wrangler secret put SUPER_ADMIN_EMAIL
npx wrangler secret put SUPER_ADMIN_PASSWORD
openssl rand -hex 32 | npx wrangler secret put PASSWORD_PEPPER
```

`PASSWORD_PEPPER` keys an HMAC over every stored password hash, so a database copy alone cannot be
cracked offline. Keep a copy: losing or changing it invalidates every password.

Changing `SUPER_ADMIN_EMAIL` later migrates the super-admin account to the new address. Once signed in to `/super`, rotate the password from the authenticated form rather than the secret — that path verifies the current password and revokes the account's other sessions.

---

## 3. Environment variables

> **Never define a `vars` block in `wrangler.jsonc`.** Every `wrangler deploy` — and every CI run — would overwrite whatever is configured in the Cloudflare dashboard.

Configure these in **Workers & Pages → `labkiosk-controller` → Settings → Variables and Secrets**:

| Variable | Example | Purpose |
| :--- | :--- | :--- |
| `DEFAULT_DOMAIN` | `labkiosk.yourdomain.com` | Platform apex; the base that subdomains hang off |
| `ISO_DOWNLOAD_URL` | a GitHub Releases asset URL | Target of `/download` and `/iso` |
| `DEFAULT_HOMEPAGE` | `https://labkiosk.yourdomain.com` | Fallback for non-enrolled clients |
| `GITHUB_ISSUES_REPO` | `owner/repo` | Optional: the repository automatic bug reports are filed in |

Use `.dev.vars` for local development only; it is not read in production.

### Optional: automatic bug reports

Organizations can opt in, under Settings → Errors & Warnings, to having their workstations' errors and warnings filed as redacted GitHub issues, after accepting the Automatic Bug Report Terms (`/terms/bug-reports`). The option stays unavailable to every organization until all three are set:

| Setting | What it is |
| :--- | :--- |
| `AI` | Workers AI binding, already in `wrangler.jsonc` |
| `GITHUB_ISSUES_TOKEN` | Secret: a fine-grained token for that one repository with **Issues: Read and write** (plus **Pull requests: Read** for a private repository) — `npx wrangler secret put GITHUB_ISSUES_TOKEN` |
| `GITHUB_ISSUES_REPO` | Variable: `owner/repo`, set in the dashboard as above |

Issues filed in a public repository are public. Token creation, the hourly triage and what Cloudflare's terms say about it: [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

### Optional: staff sign-in with Google or Microsoft

Organizations can let their staff sign in with Google Workspace or Microsoft Entra ID (`src/sso.ts`). The platform registers one OAuth client per provider for every organization; a provider whose two secrets are not both set is never offered.

The callback for every organization is one address on the platform host:
`https://<platform host>/api/auth/sso/callback`, where the platform host is `CANONICAL_HOST` when
it is set (the zone redirects the apex there, e.g. `www.labkiosk.org`) and `DEFAULT_DOMAIN`
otherwise. **Settings → Security → Single sign-on** in any organization console shows the exact
value. Register it exactly, with `https://` and no trailing slash.

**Google (Google Cloud console, the project that owns the platform's OAuth client):**

1. **Google Auth Platform → Branding** (formerly *OAuth consent screen*): app name, user support
   email, app logo optional, **Authorized domains**: your `DEFAULT_DOMAIN`; app home page
   `https://<platform host>/`, privacy policy `https://<platform host>/privacy`, terms
   `https://<platform host>/terms`; developer contact email.
2. **Audience**: user type **External** (staff of many organizations' Workspaces sign in; *Internal*
   would admit only your own Workspace), then **Publish app** so it is *In production*. While it is
   *Testing*, only the test users listed there can sign in.
3. **Data access**: the scopes `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`
   (`openid email profile`). They are non-sensitive: no Google verification review is needed
   beyond the brand verification Google may ask for.
4. **Clients → Create client**: application type **Web application**, a name, **Authorized
   redirect URIs**: the callback above. No JavaScript origins. Copy the **Client ID** and **Client
   secret**.
5. An organization whose Workspace restricts third-party apps has its Workspace administrator allow
   the app (Admin console → Security → API controls → App access control, by client ID).

**Microsoft (Microsoft Entra admin center, in the directory that owns the platform's app):**

1. **Identity → Applications → App registrations → New registration**: a name; **Supported account
   types: Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant)**;
   **Redirect URI: Web**, the callback above. Copy the **Application (client) ID**.
2. **Certificates & secrets → Client secrets → New client secret**: copy its **Value** (not the
   Secret ID) at once. It expires (24 months at most): put a renewal in the calendar, and set the
   new value before the old one lapses or Microsoft sign-in stops.
3. **API permissions**: Microsoft Graph, delegated `openid`, `email` and `profile` (keep
   `User.Read` if it is there).
4. **Token configuration → Add optional claim → ID → `email`** (accept turning on the Graph `email`
   permission if asked). Without it, accounts are matched by their user principal name.
5. Leave **Authentication → Implicit grant** off: the Worker uses the authorization code flow with
   PKCE and a client secret.
6. Recommended: **Branding & properties → Publisher verification** (a verified Microsoft partner
   ID). Many directories block users from consenting to unverified multitenant apps; an
   organization's Entra administrator can always consent for everyone with
   `https://login.microsoftonline.com/<their tenant id>/adminconsent?client_id=<MICROSOFT_CLIENT_ID>`.

**The Worker secrets** (a provider is offered only when both of its values are set; the Worker
logs once which one is missing):

```bash
cd cloudflare-control
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MICROSOFT_CLIENT_ID
npx wrangler secret put MICROSOFT_CLIENT_SECRET
npx wrangler d1 migrations apply labkiosk-db --remote   # 0046_single_sign_on.sql
```

For local development, register a separate test client with the redirect URI
`http://localhost:<port>/api/auth/sso/callback` (on a development host the callback is the
request's own origin) and put the four values in `.dev.vars`.

Each organization then turns a provider on under **Settings → Security → Single sign-on** and lists
its Google Workspace domains and/or Entra tenant IDs. Sign-in matches the verified email address to
an existing staff account (or the owner) of that organization; nothing is created, and the
organization's second-factor rule still applies afterwards.

How the sign-in is checked: [Security Model](Security-Model#single-sign-on).

→ [Configuration Reference](Configuration-Reference)

---

## 4. Routes and DNS

Every organization gets its own subdomain, so the worker needs both the apex and a wildcard.

```jsonc
"routes": [
  { "pattern": "labkiosk.yourdomain.com/*",   "zone_name": "yourdomain.com" },
  { "pattern": "*.labkiosk.yourdomain.com/*", "zone_name": "yourdomain.com" }
]
```

In Cloudflare DNS:

1. **Apex record** — `CNAME` or `A` for `labkiosk.yourdomain.com` pointing at the worker, **proxied** (orange cloud).
2. **Wildcard record** — `CNAME` with name `*.labkiosk` targeting `labkiosk.yourdomain.com`, **proxied**.
3. **Custom domains** — organizations create a `CNAME` pointing at your apex. Once a super admin approves it, the worker recognises it from the `Host` header. A domain in a zone you do not control needs a Cloudflare for SaaS custom hostname.

The orange cloud is required. An unproxied record bypasses the worker entirely.

**How many organizations this serves.** The two routes and the two DNS records serve every
organization: a new one needs no DNS record, route or certificate of its own, so Cloudflare's
per-zone DNS record quota (1,000 on Free zones created before September 2024, 200 after) never
comes into it. Keep it that way. A test fails if `wrangler.jsonc` gains another route or the
worker starts calling the DNS records or Workers routes API. Universal SSL covers a zone's apex
and the first level below it only, so serve the platform from a zone apex, as `labkiosk.org` does:
with `DEFAULT_DOMAIN` set to `labkiosk.yourdomain.com`, `<slug>.labkiosk.yourdomain.com` is a
second level and needs an Advanced Certificate Manager certificate for `*.labkiosk.yourdomain.com`.
For the same reason never add a level such as `<slug>.eu.labkiosk.org`; use a separate zone for a
region. The one per-organization cost is a custom domain.

**What custom domains cost.** Cloudflare for SaaS on the Free, Pro and Business plans includes 100
custom hostnames, then charges $0.10 a month for each one, up to 50,000; beyond that needs
Enterprise ([plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)).
1,000 organizations on their own domain cost about $90 a month. Wildcard custom hostnames
(`*.their-domain`) need Enterprise, so an organization gets one hostname. Super Admin → Tasks →
Custom domains shows how many are in use and the monthly cost, and the approval asks you to
confirm when the next one adds to it. A custom domain under the platform domain is refused.

---

## 5. Deploy

Verify first — the deploy workflow does this too, and there is no reason to find out from production:

```bash
pnpm --prefix cloudflare-control run typecheck
pnpm --prefix cloudflare-control test
```

```bash
cd cloudflare-control
npx wrangler deploy
```

### Post-deploy checks

| Check | Expect |
| :--- | :--- |
| `https://labkiosk.yourdomain.com/` | Landing page over HTTPS with hardened headers |
| `https://labkiosk.yourdomain.com/super` | Sign-in; your super-admin credentials work |
| `curl -I https://labkiosk.yourdomain.com/` | `Strict-Transport-Security`, `X-Frame-Options: DENY`, `Content-Security-Policy` with a nonce |
| `https://<slug>.labkiosk.yourdomain.com/` | The wildcard route resolves a registered organization |

If the worker will not start, it is almost always one of: missing super-admin secrets, or unapplied migrations. Both fail loudly with a specific message. → [Troubleshooting](Troubleshooting)

---

## 6. Scheduled housekeeping

```jsonc
"triggers": { "crons": ["0 * * * *"] }
```

At minute 0 of every hour Cloudflare calls `scheduled()`, which purges expired sessions, deletes delivered commands, cleans stale rate-limit rows, deletes workstation issues older than 90 days, and — when automatic bug reports are set up — triages pending issues into GitHub (at most five GitHub writes per run) and reads back the status of up to ten filed issues. Nothing needs to be provisioned for this beyond the trigger.

---

## 7. CI/CD

`.github/workflows/deploy-cloudflare.yml` is called by `ci.yml` on `main`, after `ci.yml`'s typecheck and tests passed on the same commit: on a push touching `cloudflare-control/**` or `cloudflare-email-routing/**`, or when `ci.yml` is run by hand.

Required repository secrets, under **Settings → Secrets and variables → Actions**:

| Secret | Permissions |
| :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | `Workers Scripts: Edit`, `D1: Edit`, `Account Settings: Read` |
| `CLOUDFLARE_ACCOUNT_ID` | From the Cloudflare dashboard sidebar |

Pipeline:

1. In `ci.yml`: `tsc --noEmit` on both TS projects and the multi-tenant and security test suite, for both Workers
2. `pnpm install --frozen-lockfile`
3. `wrangler d1 migrations apply labkiosk-db --remote`
4. `wrangler deploy` for the controller, then for the email Worker

Migrations are applied **before** the deploy, which is the right order: the new worker asserts the schema is current on its first request.

The other workflows: `ci.yml` on pushes and pull requests to `main` and daily (worker typechecks and tests, client syntax and policy checks, and both images when something in them changed), `build-iso.yml` on `v*` tags and manual dispatch (it boot-tests the installed disk in QEMU before releasing), `docker-publish.yml` on tags and manual dispatch.

---

## Operating notes

### Scaling

The worker is stateless, so scaling is Cloudflare's problem. The things that grow are D1 rows:

| Table | Growth | Managed by |
| :--- | :--- | :--- |
| `client_devices` | One row per workstation | Decommissioning |
| `commands` | Short-lived | Hourly cron + opportunistic purge |
| `audit_logs` | Monotonic | Nothing yet — plan a retention policy for a large deployment |
| `sessions` | Bounded by active users | Hourly cron |
| `workstation_issues` | One row per failed boot, rollback, fallback or boot error | Hourly cron, after 90 days |

A thumbnail can be up to 256 KB, and the newest one per device is stored on its row. Budget roughly 256 KB × workstation count as the upper bound for that column.

### Backups

D1 supports time-travel restore. The rows worth protecting are `users`, `tenants`, `portal_sites`, and `tenant_whitelist` — an organization's entire configuration. `client_devices` and `commands` rebuild themselves from the fleet within seconds.

### Rollback

`wrangler rollback` reverts the worker. It does **not** revert migrations, and `assertSchemaCurrent()` will refuse to serve if the older worker expects an older schema — so treat additive migrations as forward-only and keep them additive.

### Local development against production data

Don't. Use `pnpm dev` with a local D1 store; `predev` applies migrations to it automatically. → [Quickstart](Quickstart)

→ [Super Admin Guide](Super-Admin-Guide) · [Configuration Reference](Configuration-Reference) · [Control Plane Internals](Control-Plane-Internals)
