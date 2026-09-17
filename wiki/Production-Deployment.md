# Production Deployment

Deploying the control plane to Cloudflare Workers with D1, secrets, wildcard DNS, and CI/CD.

You deploy the control plane **once**; it serves every school. The client OS is deployed per workstation — → [Installation Guide](Installation-Guide).

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

---

## 2. Set the super-admin secrets

Production **fails closed** without them. There is no default administrative credential anywhere in the production path.

```bash
npx wrangler secret put SUPER_ADMIN_EMAIL
npx wrangler secret put SUPER_ADMIN_PASSWORD
```

Changing `SUPER_ADMIN_EMAIL` later migrates the super-admin account to the new address. Once signed in to `/super`, rotate the password from the authenticated form rather than the secret — that path verifies the current password and revokes the account's other sessions.

---

## 3. Environment variables

> **Never define a `vars` block in `wrangler.jsonc`.** Every `wrangler deploy` — and every CI run — would overwrite whatever is configured in the Cloudflare dashboard.

Configure these in **Workers & Pages → `labkiosk-controller` → Settings → Variables and Secrets**:

| Variable | Example | Purpose |
| :--- | :--- | :--- |
| `DEFAULT_DOMAIN` | `labkiosk.yourdomain.com` | Platform apex; the base that subdomains hang off |
| `ISO_DOWNLOAD_URL` | a GitHub Releases asset URL | Target of `/download` and `/iso` |
| `TUNNEL_DOMAIN` | `labkiosk.yourdomain.com` | Base domain for remote-assistance tunnels |
| `DEFAULT_HOMEPAGE` | `https://labkiosk.yourdomain.com` | Fallback for non-enrolled clients |

Use `.dev.vars` for local development only; it is not read in production.

→ [Configuration Reference](Configuration-Reference)

---

## 4. Routes and DNS

Every school gets its own subdomain, so the worker needs both the apex and a wildcard.

```jsonc
"routes": [
  { "pattern": "labkiosk.yourdomain.com/*",   "zone_name": "yourdomain.com" },
  { "pattern": "*.labkiosk.yourdomain.com/*", "zone_name": "yourdomain.com" }
]
```

In Cloudflare DNS:

1. **Apex record** — `CNAME` or `A` for `labkiosk.yourdomain.com` pointing at the worker, **proxied** (orange cloud).
2. **Wildcard record** — `CNAME` with name `*.labkiosk` targeting `labkiosk.yourdomain.com`, **proxied**.
3. **Custom domains** — schools create a `CNAME` pointing at your apex. Once a super admin approves it, the worker recognises it from the `Host` header. A domain in a zone you do not control needs a Cloudflare for SaaS custom hostname.

The orange cloud is required. An unproxied record bypasses the worker entirely.

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
| `https://<slug>.labkiosk.yourdomain.com/` | The wildcard route resolves a registered school |

If the worker will not start, it is almost always one of: missing super-admin secrets, or unapplied migrations. Both fail loudly with a specific message. → [Troubleshooting](Troubleshooting)

---

## 6. Scheduled housekeeping

```jsonc
"triggers": { "crons": ["0 * * * *"] }
```

At minute 0 of every hour Cloudflare calls `scheduled()`, which purges expired sessions, deletes delivered commands, and cleans stale rate-limit rows. Nothing needs to be provisioned for this beyond the trigger.

---

## 7. CI/CD

`.github/workflows/deploy-cloudflare.yml` runs on every push to `main` touching `cloudflare-control/**`.

Required repository secrets, under **Settings → Secrets and variables → Actions**:

| Secret | Permissions |
| :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | `Workers Scripts: Edit`, `D1: Edit`, `Account Settings: Read` |
| `CLOUDFLARE_ACCOUNT_ID` | From the Cloudflare dashboard sidebar |

Pipeline:

1. `pnpm install --frozen-lockfile`
2. `tsc --noEmit` on both TS projects
3. The multi-tenant and security test suite
4. `wrangler d1 migrations apply labkiosk-db --remote`
5. `wrangler deploy`

Migrations are applied **before** the deploy, which is the right order: the new worker asserts the schema is current on its first request.

The other workflows: `ci.yml` on every push (both images build, worker typechecks and tests, client syntax and policy checks), `build-iso.yml` on `v*` tags, `docker-publish.yml` on `main` and tags.

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

A thumbnail can be up to 256 KB, and the newest one per device is stored on its row. Budget roughly 256 KB × workstation count as the upper bound for that column.

### Backups

D1 supports time-travel restore. The rows worth protecting are `users`, `tenants`, `portal_sites`, and `tenant_whitelist` — a school's entire configuration. `client_devices` and `commands` rebuild themselves from the fleet within seconds.

### Rollback

`wrangler rollback` reverts the worker. It does **not** revert migrations, and `assertSchemaCurrent()` will refuse to serve if the older worker expects an older schema — so treat additive migrations as forward-only and keep them additive.

### Local development against production data

Don't. Use `pnpm dev` with a local D1 store; `predev` applies migrations to it automatically. → [Quickstart](Quickstart)

→ [Super Admin Guide](Super-Admin-Guide) · [Configuration Reference](Configuration-Reference) · [Control Plane Internals](Control-Plane-Internals)
