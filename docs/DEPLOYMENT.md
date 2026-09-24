# Production Deployment Guide

[← Back to Documentation Hub](../README.md#documentation-hub)

A step-by-step guide for deploying the Lab Kiosk multi-tenant edge control plane to Cloudflare Workers with Cloudflare D1 SQL storage, automated migrations, hardened secrets, and custom wildcard DNS.

---

## 📋 Prerequisites

Before deploying to production, ensure you have:

1. A **Cloudflare Account** with Workers and D1 enabled.
2. An active **Domain/Zone** managed in Cloudflare (e.g. `yourdomain.com`).
3. **Node.js v22+** and **pnpm** installed on your workstation.
4. **Cloudflare Wrangler CLI** authenticated to your account (`npx wrangler login`).

---

## 1. Cloudflare D1 Database Provisioning

The control plane requires Cloudflare D1 for durable multi-tenant persistence (organizations, admin users, sessions, portal apps, client devices, audit logs, and command queues).

### Step 1: Create the Remote Database

```bash
cd cloudflare-control
npx wrangler d1 create labkiosk-db
```

Wrangler will output the created database information:

```text
✅ Successfully created DB 'labkiosk-db'
{
  "binding": "DB",
  "database_name": "labkiosk-db",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

### Step 2: Configure `wrangler.jsonc`

Open `cloudflare-control/wrangler.jsonc` and paste your generated `database_id`:

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

### Step 3: Apply Database Migrations

Apply all schema migrations remotely to initialize the database tables:

```bash
npx wrangler d1 migrations apply labkiosk-db --remote
```

> [!IMPORTANT]
> **Rule 7 (Fail Closed):** The worker refuses to serve a bound database whose migrations have not been applied (`assertSchemaCurrent()`). A deployed worker never creates tables dynamically at runtime, ensuring strict schema migration tracking.

### Upgrading an existing deployment

Pending migrations are applied the same way. Two of them change existing data:

- **`0010_workstation_broadcast.sql`** adds per-workstation broadcast state. Deploy the Worker in the
  same release: the new Worker reads these columns on every heartbeat.
- **`0011_organization_vocabulary.sql`** renames the stored roles (`school_admin` → `org_admin`,
  `teacher` → `operator`, `lab_assistant` → `assistant`) and the staff permission (`teachers` →
  `staff`) by rebuilding every table that references `users`. It is written to be cascade-safe and
  is applied as one unit, but it rewrites your core tables, so **export the database first**:

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

## 2. Secrets & Administrative Authentication

Production deployments **fail closed** if super-admin secrets are unset. No default or fallback administrative credentials exist in production paths.

### Configure Required Secrets

Run the following commands to securely set the initial platform super-admin credentials:

```bash
npx wrangler secret put SUPER_ADMIN_EMAIL
# Enter the platform administrator email (e.g., admin@yourdomain.com)

npx wrangler secret put SUPER_ADMIN_PASSWORD
# Enter a strong password (minimum 8 characters)
```

> [!NOTE]
> Updating `SUPER_ADMIN_EMAIL` in the future will automatically migrate the super-admin account to the new email address. Once logged in to the `/super` console, passwords can also be rotated directly via the authenticated password-change interface.

---

## 3. Managing Environment Variables

In accordance with production deployment standards, **never define a `vars` block in `wrangler.jsonc`**, because subsequent runs of `wrangler deploy` or GitHub Actions will overwrite environment variables configured in the Cloudflare dashboard.

Configure production variables in the **Cloudflare Dashboard**:

1. Go to **Workers & Pages** → Select `labkiosk-controller`.
2. Navigate to **Settings** → **Variables and Secrets**.
3. Under **Environment Variables**, configure:
   - `DEFAULT_DOMAIN`: The primary apex platform domain (e.g. `labkiosk.yourdomain.com`).
   - `ISO_DOWNLOAD_URL`: Direct link to download the live bootable Debian 12 Kiosk ISO (e.g. GitHub Releases artifact).
   - `TUNNEL_DOMAIN`: Base domain for remote assistance tunnels (e.g. `labkiosk.yourdomain.com`).

---

## 4. Wildcard DNS & Route Configuration

Every registered organization receives its own isolated subdomain (e.g. `greenwood.labkiosk.yourdomain.com`).

### 1. Update Routes in `wrangler.jsonc`

Update the `routes` block in `cloudflare-control/wrangler.jsonc` to match your domain zone:

```jsonc
"routes": [
  { "pattern": "labkiosk.yourdomain.com/*", "zone_name": "yourdomain.com" },
  { "pattern": "*.labkiosk.yourdomain.com/*", "zone_name": "yourdomain.com" }
]
```

### 2. Configure Cloudflare DNS

In your Cloudflare Dashboard under your domain's **DNS Records**:

1. **Apex / Host Record:** Add a `CNAME` or `A` record for `labkiosk.yourdomain.com` pointing to the Worker (Proxied: Orange Cloud).
2. **Wildcard Subdomain Record:** Add a `CNAME` record with Name `*` or `*.labkiosk` targeting `labkiosk.yourdomain.com` (Proxied: Orange Cloud).
3. **Custom Domain Support:** When organizations request custom domains (e.g. `kiosk.example.com`), they create a `CNAME` pointing to `labkiosk.yourdomain.com`. Once approved by the Super Admin in `/super`, Cloudflare Workers handles routing authoritatively via the `Host` header.

---

## 5. Deploying the Worker

Run strict typechecks and the test suite locally first:

```bash
pnpm --prefix cloudflare-control run typecheck
pnpm --prefix cloudflare-control test
```

Deploy the worker to the Cloudflare Edge network:

```bash
cd cloudflare-control
npx wrangler deploy
```

Once deployed, visit your apex URL (e.g. `https://labkiosk.yourdomain.com/`):

- The public SaaS landing page should load with HTTPS and hardened security headers.
- Access `https://labkiosk.yourdomain.com/super` and sign in with your `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`.

---

## 6. Scheduled Background Housekeeping

The worker defines an hourly cron trigger in `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": ["0 * * * *"]
}
```

Cloudflare automatically calls the worker's `scheduled()` handler at minute 0 of every hour:

- Purges expired user and admin sessions.
- Deletes delivered and acknowledged commands from the command queue.
- Cleans up stale rate-limiting and sign-in throttle rows.

---

## 7. Automated CI/CD with GitHub Actions

The repository includes a production deployment workflow in `.github/workflows/deploy-cloudflare.yml`.

### Required GitHub Repository Secrets

Under **Settings** → **Secrets and variables** → **Actions**, configure:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API Token with `Workers Scripts: Edit`, `D1: Edit`, and `Account Settings: Read` permissions.
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID (visible on Cloudflare Dashboard sidebar).

### Workflow Pipeline

On every push to `main` modifying `cloudflare-control/**`:

1. Installs dependencies via `pnpm` with frozen lockfile.
2. Executes strict TypeScript typechecks (`tsc --noEmit`).
3. Executes automated multi-tenant and negative security test suite.
4. Applies any pending remote D1 migrations (`wrangler d1 migrations apply labkiosk-db --remote`).
5. Executes `wrangler deploy` to publish the updated worker across Cloudflare global edge data centers.

---

## 8. Workstation fleet Network & Firewall Deployment Requirements

For workstations running Lab Kiosk OS to communicate reliably with the Cloudflare control plane:

### Outbound Firewall Rules (Egress)

Organization firewalls should permit outbound connections for the following ports and hosts:

- **HTTPS (`TCP 443`):** To `<organization>.labkiosk.yourdomain.com` (telemetry, enrollment, and web pages).
- **DNS (`UDP/TCP 53`):** To organization DNS servers or public resolvers (`1.1.1.1`, `8.8.8.8`).
- **Cloudflare Tunnel (`TCP 7844` / `UDP 7844` QUIC):** Optional, required only if remote desktop assistance via `cloudflared` is deployed.

### Network Addressing & Proxy Architecture

- **Ethernet & Wi-Fi:** Workstations support standard DHCP (IPv4 & IPv6), Custom DNS overrides (`ignore-auto-dns yes`), or fixed Static IPs configured via the setup wizard.
- **HTTP / HTTPS Proxy:** Organization districts operating transparent or explicit proxy servers (e.g. Squid, Lightspeed, Smoothwall, Fortinet) can specify the proxy host and port during setup. Settings are stored in `/etc/labkiosk/proxy.json` (persisted on the data partition), applied to the agent's own requests, and enforced in Chromium managed policy (`ProxySettings` with `ProxyMode: "fixed_servers"`). Loopback is always exempt.
- **Persistence:** All network configurations and Wi-Fi credentials are saved to the persistent `LABKIOSK_DATA` partition and bind-mounted on boot, surviving `overlayroot="tmpfs"` reboots.
