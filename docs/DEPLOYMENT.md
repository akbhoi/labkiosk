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

The control plane requires Cloudflare D1 for durable multi-tenant persistence (organizations, admin users, sessions, portal apps, client devices, audit logs, workstation errors and warnings, and bug reports).

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

Pending migrations are applied the same way. What some of them change:

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
- **`0014_org_hub_live_state.sql`** moves live state out of D1: it **drops the `commands` and
  `command_deliveries` tables and `client_devices.thumbnail`**, and adds
  `tenants.online_workstations`, `custom_hostname_id` and `custom_hostname_status`. Commands
  queued at that moment are lost (they expired within a minute anyway). Create the
  [platform resources](#platform-resources) first — the new worker refuses to start without them —
  and deploy in the same release, because the old worker reads the dropped tables. Workstations
  from an older ISO keep working over the HTTP heartbeat; those with `python3-websocket` connect
  over a WebSocket.
- **`0015_workstation_boot_reports.sql` … `0018_bug_report_triage.sql`** only add columns and two
  tables (`workstation_issues`, behind Settings → Errors & Warnings, and `bug_reports`); nothing
  existing is rebuilt or deleted. 0015 stores each installed workstation's last boot outcome
  (`POST /api/devices/boot-report`); 0017 and 0018 hold the opt-in
  [automatic bug reports](#automatic-bug-reports-optional), off until an organization opts in and
  accepts the terms. The new worker refuses to serve until all four are applied, so apply them and
  deploy in the same release.

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

## Platform resources

The worker needs more than D1. Live workstation state lives in one **OrgHub** Durable Object per
organization, audit entries go through a queue and are archived to R2, and custom domains are
provisioned by a Workflow. **A production worker refuses to start without every one of them**
(`requiredBindingsProblem()`), and the error names each one that is missing.

| Binding | What it is | Create it |
| :--- | :--- | :--- |
| `ORG_HUB` | Durable Object class `OrgHub` (SQLite-backed) | Nothing to create: the first deploy applies the `v1-org-hub` migration in `wrangler.jsonc`. |
| `AUDIT_QUEUE` | Queue `labkiosk-audit`, dead-letter queue `labkiosk-audit-dlq` | `npx wrangler queues create labkiosk-audit` and `npx wrangler queues create labkiosk-audit-dlq` |
| `AUDIT_ARCHIVE` | R2 bucket `labkiosk-audit-archive` (audit entries older than 180 days, as NDJSON) | `npx wrangler r2 bucket create labkiosk-audit-archive` |
| `FLEET_METRICS` | Analytics Engine dataset `labkiosk_fleet` (connects and disconnects) | Nothing: it is created on first write. |
| `AUTH_RATE_LIMITER` | Rate limit, namespace `1001`, 20 requests per 60 s per address | Nothing; change `namespace_id` if your account already uses `1001`. |
| `CUSTOM_HOSTNAMES` | Workflow `labkiosk-custom-hostnames` | Nothing: created on deploy. |
| `CF_API_TOKEN` | Secret: an API token for the zone with **SSL and Certificates: Edit** (custom hostnames) | `npx wrangler secret put CF_API_TOKEN` |
| `CF_ZONE_ID` | Secret: the zone id of your platform domain | `npx wrangler secret put CF_ZONE_ID` |

**Custom domains (Cloudflare for SaaS).** When a super admin approves an organization's custom
domain, the Workflow creates a custom hostname on your zone, waits for its certificate, and records
`custom_hostname_status` (`pending`, then `active` or `failed`); removing the domain deletes it.
Before the first approval, enable Cloudflare for SaaS on the zone, set a **fallback origin** (a
proxied DNS record on your zone), and make sure the worker serves custom hostnames — Cloudflare's
guide for using a Worker as the SaaS origin describes the catch-all route. Each organization then
points its domain at the fallback origin with a CNAME.

**Local development** needs none of this: `pnpm dev` (`wrangler dev --local`) runs every binding
locally except Workers AI, which it leaves out,
and with `ALLOW_LOCAL_DB=1` a custom domain is marked `local` instead of provisioned. wrangler's
local rate-limit simulator throws on every call; the worker logs that and keeps to the D1 lockouts.

**The CI token.** `wrangler deploy` now also binds a queue, a bucket and a Workflow. If the deploy
reports an authorization error, add the permission it names to `CLOUDFLARE_API_TOKEN`.

### Automatic bug reports (optional)

Organizations can opt in, in Settings → Errors & Warnings, to having their workstations' errors and
warnings filed as GitHub issues (`src/bug_reports.ts`), after accepting the Automatic Bug Report
Terms (`/terms/bug-reports`, versioned by `BUG_REPORT_TERMS_VERSION`). The hourly cron masks
addresses, host names and identifiers, links repeats of a known problem, asks a reasoning model
whether a new problem matches an open report (matched: one comment on that issue; otherwise a new
issue whose title and summary it drafts), and reads each issue's status back from GitHub (in
progress: assigned or labelled "in progress"; PR created: referenced by a pull request in the same
repository; resolved: closed as completed; closed: closed for another reason). The option stays
unavailable to every organization until all three of these are set:

| Setting | What it is | Set it |
| :--- | :--- | :--- |
| `AI` | Workers AI binding (reasoning model `@cf/openai/gpt-oss-120b`, effort `high`) | Already in `wrangler.jsonc`. Workers AI has no local simulator: `pnpm dev` runs with `--local`, which leaves it out (the option stays unavailable); plain `npx wrangler dev` calls your account and needs `wrangler login`. |
| `GITHUB_ISSUES_TOKEN` | Secret: a fine-grained GitHub token for one repository with **Issues: Read and write** (and **Pull requests: Read** for a private repository) | `npx wrangler secret put GITHUB_ISSUES_TOKEN` |
| `GITHUB_ISSUES_REPO` | Variable: the repository issues are filed in, `owner/repo` | Dashboard → Variables and Secrets (section 3) |

Issues filed in a public repository are public. Each organization's administrator sees the
repository name before turning the option on.

### Optional: automatic Remote Control tunnels

Organizations can let the platform create a Cloudflare Tunnel, DNS record and Access application
for each workstation (Settings → Domains → Automatic Remote Control Tunnels;
`src/remote_tunnels.ts`), either in **their own** Cloudflare account and domain, or, for an
organization with no domain, on the **platform's remote-control domain** as
`<organization>-<workstation>-vnc.<domain>`. Organizations' API tokens and every workstation's run
token are stored sealed with AES-GCM under one platform secret. Without it the option is
unavailable; without the six `REMOTE_TUNNEL_PLATFORM_*` settings only the organization's own
domain is offered:

| Setting | What it is | Set it |
| :--- | :--- | :--- |
| `REMOTE_TUNNEL_KEY` | Secret: 32 random bytes, base64 | `openssl rand -base64 32 \| npx wrangler secret put REMOTE_TUNNEL_KEY` |
| `REMOTE_TUNNEL_PLATFORM_DOMAIN` | The platform's remote-control domain: `DEFAULT_DOMAIN` itself (`labkiosk.org`) or a zone of its own | `npx wrangler secret put REMOTE_TUNNEL_PLATFORM_DOMAIN` |
| `REMOTE_TUNNEL_PLATFORM_ACCOUNT_ID` | The Cloudflare account that zone is on | `npx wrangler secret put REMOTE_TUNNEL_PLATFORM_ACCOUNT_ID` |
| `REMOTE_TUNNEL_PLATFORM_ZONE_ID` | That zone's id (**Overview** → *API* → *Zone ID*) | `npx wrangler secret put REMOTE_TUNNEL_PLATFORM_ZONE_ID` |
| `REMOTE_TUNNEL_PLATFORM_TOKEN` | Secret: API token for it (below) | `npx wrangler secret put REMOTE_TUNNEL_PLATFORM_TOKEN` |
| `REMOTE_TUNNEL_PLATFORM_ACCESS_CLIENT_ID` | The Remote Control gate's Access service token: its Client ID (below) | `npx wrangler secret put REMOTE_TUNNEL_PLATFORM_ACCESS_CLIENT_ID` |
| `REMOTE_TUNNEL_PLATFORM_ACCESS_CLIENT_SECRET` | Secret: that service token's Client Secret | `npx wrangler secret put REMOTE_TUNNEL_PLATFORM_ACCESS_CLIENT_SECRET` |

The platform's remote-control domain is **`DEFAULT_DOMAIN` itself or a zone of its own, never a
name under `DEFAULT_DOMAIN`** (the Worker refuses one that is, and logs why): each workstation is
one label under the domain, `greenwood-pc-01-vnc.labkiosk.org`, so the zone's free Universal SSL
certificate covers it, and `vnc.labkiosk.org` would need a certificate it does not have.

On `DEFAULT_DOMAIN` the console and the workstations share one zone, so:

- each workstation address gets its own **Worker route with no Worker** (`<address>/*`), created
  and deleted with its tunnel. It is more specific than `*.<DEFAULT_DOMAIN>/*`, so the tunnel, not
  the console, answers that address. A zone holds at most 1000 routes, which caps platform
  workstations at about 998. They name no Worker, and `wrangler deploy` sets only this Worker's
  routes, so a deploy does not remove them;
- organization names `vnc` and `*-vnc` are reserved, so no organization's console shares a
  Remote Control address;
- the browser sends the console's session cookie (`Domain=.<DEFAULT_DOMAIN>`) to Remote Control
  pages too, so the console treats them as cross-site: a request from one cannot act with that
  cookie. The gate never forwards a browser's cookies, and Access stops anyone else before the
  workstation.

A zone of its own needs none of this.

**No Zero Trust seats.** Each workstation's Access application on that zone admits only the
gate's service token, and a service token takes no seat. Operators open Remote Control through the
**gate** at `vnc.<domain>` (`src/remote_gate.ts`): the console gives a signed-in operator with the
Workstations permission a pass valid for two minutes, and the gate forwards that session to the
workstation with the service token. On `DEFAULT_DOMAIN` the gate is already served by the
`*.<DEFAULT_DOMAIN>/*` route and wildcard DNS record. On a zone of its own it needs:

1. a proxied DNS record for `vnc` (for example `AAAA vnc 100::`, orange cloud on);
2. **one** Worker route, `vnc.<domain>/*` → `labkiosk-controller`, added to `routes` in
   `wrangler.jsonc` once the zone is active (a route on a zone that is not active fails the
   deploy). Never `*.<domain>/*`: a Worker cannot `fetch()` a host its own route covers, so the
   gate could no longer reach the workstations.

Changing or losing the key makes every stored token unreadable: organizations then have to turn
the tunnels off in their own Cloudflare dashboard and on again here. Images must ship cloudflared
(`distro-builder/config/includes.chroot/usr/share/labkiosk/cloudflared.pin`).

### Creating the tokens

**`GITHUB_ISSUES_TOKEN`** (GitHub, fine-grained personal access token):

1. On GitHub: your avatar → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**.
2. Name it (for example `labkiosk-bug-reports`) and pick an expiration. When it expires, the cron
   logs `[BugReports] … GitHub answered 401` and reports wait until you set a new token.
3. **Resource owner:** the account or organization that owns the repository. **Repository access:**
   *Only select repositories* → the one repository in `GITHUB_ISSUES_REPO`.
4. **Permissions → Repository permissions:** **Issues: Read and write**. For a private repository
   also **Pull requests: Read-only**. (*Metadata: Read-only* is added automatically.) Nothing else.
5. **Generate token**, copy it once, then from `cloudflare-control/`:
   `npx wrangler secret put GITHUB_ISSUES_TOKEN` and paste it. Never put it in `wrangler.jsonc`,
   `.dev.vars` committed to git, or a chat.

Issues and comments appear as written by the account that owns the token. To keep them apart
from your own activity, create the token on a separate bot account that has write access to the
repository.

**`GITHUB_ISSUES_REPO`:** Cloudflare dashboard → **Workers & Pages** → `labkiosk-controller` →
**Settings** → **Variables and Secrets** → **Add** → type *Text*, name `GITHUB_ISSUES_REPO`,
value `owner/repo` → **Deploy**.

**`CF_API_TOKEN`** (custom domains): Cloudflare dashboard → **My Profile** → **API Tokens** →
**Create Token** → **Create Custom Token**. Permissions: *Zone* · *SSL and Certificates* · *Edit*.
Zone Resources: *Include* · *Specific zone* · your platform domain's zone. **Create Token**, then
`npx wrangler secret put CF_API_TOKEN`. **`CF_ZONE_ID`** is on that zone's **Overview** page
(right-hand column, *API* → *Zone ID*): `npx wrangler secret put CF_ZONE_ID`.

**`REMOTE_TUNNEL_PLATFORM_TOKEN`** (the platform's remote-control domain): Cloudflare dashboard →
**My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**. Permissions:
*Account* · *Cloudflare Tunnel* · *Edit*; *Account* · *Access: Apps and Policies* · *Edit*;
*Zone* · *DNS* · *Edit*; and, when the domain is `DEFAULT_DOMAIN`, *Zone* · *Workers Routes* ·
*Edit*. Account Resources: *Include* · the account the zone is on. Zone
Resources: *Include* · *Specific zone* · the remote-control zone only. Zero Trust must be set up
on that account (**Zero Trust** → pick a team name and plan). **Create Token**, then
`npx wrangler secret put REMOTE_TUNNEL_PLATFORM_TOKEN`. Add *Account* · *Access: Service Tokens*
· *Read* too: turning the mode on looks up the gate's service token by its Client ID.

**`REMOTE_TUNNEL_PLATFORM_ACCESS_CLIENT_ID` / `_SECRET`** (the gate's service token): Cloudflare
dashboard → **Zero Trust** → **Access** → **Service credentials** → **Service Tokens** →
**Create Service Token**. Name it `labkiosk-remote-control-gate`, duration *Non-expiring* (or
renew it before it expires: an expired token closes every platform workstation). Copy the
**Client ID** and **Client Secret** once, then `npx wrangler secret put` each.

Workers AI needs no token: the `AI` binding uses the account the Worker is deployed to.

### Privacy and Cloudflare's terms

The hosted platform's [Privacy Policy](../cloudflare-control/src/ui_legal.ts) (`/privacy`) names
every Cloudflare service in `wrangler.jsonc` and what each one handles, and refers to the
[Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/) and the
[Cloudflare Customer Data Processing Addendum](https://www.cloudflare.com/cloudflare-customer-dpa/).
If you add a binding, add it there too (a test checks the list). If you run your own deployment,
you are the operator: review Cloudflare's DPA for your account and publish your own policy.

---

## 3. Managing Environment Variables

In accordance with production deployment standards, **never define a `vars` block in `wrangler.jsonc`**, because subsequent runs of `wrangler deploy` or GitHub Actions will overwrite environment variables configured in the Cloudflare dashboard.

Configure production variables in the **Cloudflare Dashboard**:

1. Go to **Workers & Pages** → Select `labkiosk-controller`.
2. Navigate to **Settings** → **Variables and Secrets**.
3. Under **Environment Variables**, configure:
   - `DEFAULT_DOMAIN`: The primary apex platform domain (e.g. `labkiosk.yourdomain.com`).
   - `CANONICAL_HOST` (optional, set as a secret like `DEFAULT_DOMAIN`): the host search engines
     should list the public pages under, when the zone redirects the apex to it (e.g.
     `www.labkiosk.yourdomain.com`). It must be `DEFAULT_DOMAIN` or a host under it; without it the
     apex is canonical.
   - `ISO_DOWNLOAD_URL`: Direct link to download the live bootable Debian 12 Kiosk ISO (e.g. GitHub Releases artifact).
   - `TUNNEL_DOMAIN`: Base domain for remote assistance tunnels (e.g. `labkiosk.yourdomain.com`).
   - `GITHUB_ISSUES_REPO` (optional): `owner/repo` for automatic bug reports (see "Automatic bug reports").

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

### 3. Search engines and website analytics

Only the platform's public pages are meant for search results: `/`, `/privacy`, `/terms` and
`/terms/bug-reports` on the platform host. The worker serves `/robots.txt` and `/sitemap.xml`
there, and sends `X-Robots-Tag: noindex, nofollow` with every other page: organization
subdomains, custom domains, the consoles, the User Portal and the `workers.dev` address.

Website analytics are optional and run through Cloudflare Zaraz, which injects its snippet at the
edge. The worker's Content Security Policy lets Zaraz's loader (`/cdn-cgi/zaraz/s.js`) run only on
the public pages of the platform host, so no analytics tool can run on a workstation or a console.
Scripts injected without the page's nonce (Google tag gateway, for example) stay blocked: use
Zaraz. If you turn Zaraz on, describe it in the Privacy Policy (`src/ui_legal.ts`, section 8) and
put the analytics tool behind Zaraz consent.

The home page asks for that consent itself, with a bar along the bottom that leaves the page usable
(Zaraz's own consent dialog is modal and blocks the whole page). In **Zaraz → Consent**, keep the
cookie name `zaraz-consent` and turn on **Hide modal by default**. A Configuration Rule that turns
Zaraz off outside the public pages must still let `/cdn-cgi/zaraz/*` through, or the loader
answers 404 and nothing loads.

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
- Cleans up stale rate-limiting and sign-in throttle rows.
- Moves audit entries older than 180 days to the `labkiosk-audit-archive` R2 bucket (one NDJSON
  file per run) and deletes them from D1.
- Deletes workstation errors and warnings older than 90 days.
- Triages pending automatic bug reports into GitHub issues, when they are set up (at most 5 GitHub
  writes a run; a GitHub or model failure leaves the rest for the next run), and reads back the
  status of up to 10 filed issues.

Queued commands are no longer in D1: each organization's OrgHub expires its own.

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

- **HTTPS (`TCP 443`):** To `<organization>.labkiosk.yourdomain.com` (the control channel, enrollment, and web pages). The control channel is a long-lived WebSocket; a proxy that refuses WebSocket upgrades only costs efficiency, because the agent falls back to the 3-second HTTPS heartbeat after three failed attempts.
- **DNS (`UDP/TCP 53`):** To organization DNS servers or public resolvers (`1.1.1.1`, `8.8.8.8`).
- **Cloudflare Tunnel (`TCP 7844` / `UDP 7844` QUIC):** Optional, required only if remote desktop assistance via `cloudflared` is deployed.

### Network Addressing & Proxy Architecture

- **Ethernet & Wi-Fi:** Workstations support standard DHCP (IPv4 & IPv6), Custom DNS overrides (`ignore-auto-dns yes`), or fixed Static IPs configured via the setup wizard.
- **HTTP / HTTPS Proxy:** Organization districts operating transparent or explicit proxy servers (e.g. Squid, Lightspeed, Smoothwall, Fortinet) can specify the proxy host and port during setup. Settings are stored in `/etc/labkiosk/proxy.json` (persisted on the data partition), applied to the agent's own requests, and enforced in Chromium managed policy (`ProxySettings` with `ProxyMode: "fixed_servers"`). Loopback is always exempt.
- **Persistence:** All network configurations and Wi-Fi credentials are saved to the persistent `LABKIOSK_DATA` partition and bind-mounted on boot, surviving `overlayroot="tmpfs"` reboots.
