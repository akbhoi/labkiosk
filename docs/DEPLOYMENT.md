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
| `REMOTE_RELAY` | Durable Object class `RemoteRelay` (SQLite-backed), one per workstation while Remote Control is open | Nothing to create: the first deploy applies the `v2-remote-relay` migration. |
| `ASSETS` | Static assets in `public/`: the noVNC client the Remote Control viewer loads from `/novnc/` | Nothing: `wrangler dev` and `wrangler deploy` run `scripts/stage-novnc.mjs` (`build.command`), which copies the exactly pinned `@novnc/novnc` from `node_modules`, so run `pnpm install` first. |
| `AUDIT_QUEUE` | Queue `labkiosk-audit`, dead-letter queue `labkiosk-audit-dlq` | `npx wrangler queues create labkiosk-audit` and `npx wrangler queues create labkiosk-audit-dlq` |
| `AUDIT_ARCHIVE` | R2 bucket `labkiosk-audit-archive` (audit entries older than 180 days, as NDJSON) | `npx wrangler r2 bucket create labkiosk-audit-archive` |
| `FLEET_METRICS` | Analytics Engine dataset `labkiosk_fleet` (connects and disconnects) | Nothing: it is created on first write. |
| `AUTH_RATE_LIMITER` | Rate limit, namespace `1001`, 20 requests per 60 s per address | Nothing; change `namespace_id` if your account already uses `1001`. |
| `CUSTOM_HOSTNAMES` | Workflow `labkiosk-custom-hostnames` | Nothing: created on deploy. |
| `CF_API_TOKEN` | Secret: an API token for the zone with **SSL and Certificates: Edit** (custom hostnames) | `npx wrangler secret put CF_API_TOKEN` |
| `CF_ZONE_ID` | Secret: the zone id of your platform domain | `npx wrangler secret put CF_ZONE_ID` |

**Remote Control cost.** A Remote Control session is one `RemoteRelay` Durable Object holding two
WebSockets (the operator's viewer and the workstation's agent) for as long as the session is open,
so it is billed as Durable Object duration while open plus WebSocket messages at 20:1. Both sides
send a small keepalive every 30 s, which the relay answers without waking. On the Workers Paid plan
this is roughly a cent or less per hour of active session (estimated, not measured); on the Free plan it counts against the daily Durable
Object allowance. Nothing runs while no session is open.

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

### Email

Registration, Remote Control requests and the Super Admin **Tasks** and **Mail** tabs run on
email. New organizations register with a verified email address and a phone number, and stay
`pending` until a super admin confirms the phone and approves them under **Tasks**; Remote Control
is off for every organization until it asks under Settings and a super admin approves it. Replies
are written in the Super Admin console and sent from the platform, and the customer's answers come
back into the same conversation.

**Mail** is a small mailbox for the whole domain: every message sent to any address on it
(`SUPPORT_ADDRESS`'s domain, e.g. anything `@labkiosk.org`) is filed under the address it was sent
to, with unread counts per address. A super admin reads, replies, writes new mail as any address on
the domain, closes, reopens and deletes it, and downloads attachments. When the sending domain is
the mail domain itself (`MAIL_FROM` on `labkiosk.org`), mail goes out from the address it was
written as. With a sending subdomain it goes out as the same name there (`sales@labkiosk.org` is
sent from `sales@email.labkiosk.org`) with Reply-To set to the address itself, so answers come back.

Incoming mail arrives through a second, small Worker, `labkiosk-email-routing`
(`cloudflare-email-routing/`), which the catch-all points at. It keeps the original, attachments
included, in the `AUDIT_ARCHIVE` R2 bucket under `mail/` and hands it to the controller's
`MailIntake` entrypoint over a Service Binding; the controller files it. If the controller is
failing at that moment, the message waits in R2 (`mail-pending/`) and the controller's hourly run
files it, so a broken deploy delays mail instead of losing or bouncing it. Messages larger than
10 MB are shown from their headers (the original is still downloadable), and the original is
removed when its conversation is deleted. The CI deploy publishes the controller first and then
this Worker, because its binding names the controller's entrypoint.

| Piece | What it is | Set it up |
| :--- | :--- | :--- |
| `EMAIL` | `send_email` binding, Cloudflare Email Service (outbound), on **both** Workers | Declared in each `wrangler.jsonc`. Onboard a sending domain once (Dashboard → Email → Email Sending, e.g. `labkiosk.org`). Sending needs Workers Paid; 3,000 messages a month are included. |
| `MAILER` | Service Binding from `labkiosk-controller` to `labkiosk-email-routing`: every outgoing message is handed over (`POST /send`), rendered with the templates in `cloudflare-email-routing/src/templates/` and sent from there. When that Worker does not answer, the controller renders the same template and sends through its own `EMAIL` | Declared in `cloudflare-control/wrangler.jsonc`. The two Workers bind each other, so on a **first install** deploy the controller with the `services` block commented out, deploy `labkiosk-email-routing`, then deploy the controller again with it |
| `MAIL_FROM` | Variable: the sender, on the onboarded domain, e.g. `Lab Kiosk <support@labkiosk.org>`. Its domain is the sending domain for every mailbox; its name is the display name | Dashboard variable on `labkiosk-controller` |
| `SUPPORT_ADDRESS` | Variable: the address customers reply to and write to, e.g. `support@labkiosk.org`. Its domain is the one the **Mail** tab serves | Dashboard variable on `labkiosk-controller` |
| `SUPPORT_FORWARD_TO` | Variable, optional: a verified Email Routing destination that gets a copy of every incoming message that is not a loop, and every message that could not be stored | Dashboard variable on `labkiosk-email-routing` (and on `labkiosk-controller` too if mail is ever routed straight to it) |
| `labkiosk-email-routing` | The Worker that receives the domain's mail and sends the platform's (`cloudflare-email-routing/`): R2 binding `MAIL_ARCHIVE` (the same `labkiosk-audit-archive` bucket), Service Binding `CONTROLLER` to `labkiosk-controller`'s `MailIntake`, and its own `EMAIL` send_email binding | Deployed by the same workflow as the controller; nothing to create by hand. To deploy it yourself, deploy the controller first, then `pnpm --prefix cloudflare-email-routing exec wrangler deploy` |
| Email Routing catch-all | Routes every address on the domain to `labkiosk-email-routing` | Dashboard → `labkiosk.org` → Email → Email Routing → Routing rules → *Catch-all address* → Action *Send to a Worker* → `labkiosk-email-routing`, enabled. Rules for single addresses take precedence; remove any that should land in **Mail** instead. The controller's own `email()` handler still files mail routed straight to it |
| `AUDIT_ARCHIVE` | The R2 bucket production already requires; incoming originals are stored under `mail/` | Nothing new |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Optional: Cloudflare Turnstile in front of the signup email code and the contact form. Free. Set both or neither: one alone makes those forms refuse | Dashboard → Turnstile → *Add widget* (hostname `labkiosk.org`, mode *Managed*); the site key as a variable, the secret key as a secret (`wrangler secret put TURNSTILE_SECRET_KEY`) |

Without a way to send (`MAILER` or `EMAIL`), `MAIL_FROM` and `SUPPORT_ADDRESS`, registration and
replies refuse with "Email is not configured"; the rest of the Worker runs. Incoming mail joins a
conversation only when its subject carries the conversation's tracking ID (`[SUP-XXXXXX]`) or it
answers one of the platform's messages, **and** it comes from that conversation's contact; anything
else opens a new conversation in the mailbox it was sent to.

**Tracking IDs and types.** A conversation is filed by what it is about, and its tracking ID starts
with that type's prefix: `REG` registration, `RMT` Remote Control, `SUP` support, `SAL` sales, `BIL`
billing, `LGL` legal and privacy, `GEN` general, `LTR` a letter written in the console. Mail is typed
by the address it was sent to (`sales@`, `quotes@`, `pricing@` are sales; `billing@`, `accounts@`,
`invoices@` billing; `legal@`, `privacy@`, `abuse@`, `security@` legal; `support@`, `help@` support;
anything else general), and the contact form by its topic. **Tasks** and **Mail** filter by type.
Conversations from before this keep their `LK-` reference, and replies to them still thread. The
sender of a new email is sent a receipt with the tracking ID, once a day per address, and never for
an automatic message, a bounce or a no-reply address.

**Templates.** Every message goes out in one layout (wordmark, body, footer with the reply address
and why it was sent) with a plain-text copy, from one of seven templates: `code`, `receipt`,
`reply`, `decision`, `letter`, `alert` and `notice`. They live in
`cloudflare-email-routing/src/templates/`; `pnpm --prefix cloudflare-email-routing run preview`
writes each one to `cloudflare-email-routing/previews/` to look at in a browser. Mail from the sending domain itself is dropped, so a
bounce cannot loop; with `MAIL_FROM` on `labkiosk.org` that is any message whose author or envelope
sender is an `@labkiosk.org` address. Phone numbers are
confirmed by hand (**Mark phone as verified** after a call or message); no SMS provider is used.

**BIMI** (the logo mail clients show beside the platform's email) is served by the Worker at
`https://labkiosk.org/bimi.svg`, in the SVG Tiny PS profile BIMI requires. It needs DMARC at
`p=quarantine` or `p=reject` on the domain (labkiosk.org already has `p=quarantine`) and one TXT
record: name `default._bimi`, content `v=BIMI1; l=https://labkiosk.org/bimi.svg;`. Yahoo, AOL and
Fastmail show the logo with that alone. Gmail and Apple Mail show it only with a Verified or Common
Mark Certificate (a paid certificate from DigiCert or Entrust; a VMC also needs a registered
trademark), whose PEM URL then goes in the same record as `a=<url>`.

**Sign-in security** needs no setup. After the password, a super admin is always emailed a
six-digit code, so `SUPER_ADMIN_EMAIL` must reach an inbox that can be read without signing in to
the console (not a mailbox that exists only in its **Mail** tab). An organization account turns the
emailed code on under Settings → Two-factor sign-in; an authenticator app with ten recovery codes is
optional on top for every account. A sign-in from a browser the account has not used before is
emailed to the account. Where email is not configured, an account without an app signs in with its
password alone and the server logs why.

Locally (`ALLOW_LOCAL_DB=1`) nothing is sent unless `MAIL_FROM` is set: messages go to an in-process
outbox the tests read (`localOutbox()` in `src/mail.ts`) and each subject is logged, so under
`pnpm dev` a sign-in or registration code is read from the terminal
(`[Mail] Local outbox, not sent: ... 123456 is your Lab Kiosk sign-in code`).

### Release notes on /download

Nothing to set up. The ISO build publishes each release on GitHub with the change list GitHub writes
from the merged pull requests. The Worker's hourly run reads the newest releases (anonymously, or with
`GITHUB_ISSUES_TOKEN` when that is set, which avoids GitHub's limit on anonymous reads) into the
`release_notes` table, and `/download` shows each one: its version, date, ISO and checksum exactly as
GitHub published them. With the `AI` binding, Workers AI rewrites each change list as a few sentences
for the people who run workstations, and the page marks them as written by AI beside a link to the
full notes; without it, the change list itself is shown. Edit a release's notes on GitHub and its
summary is rewritten on the next run. Until the first run after a deploy, the page links GitHub's
`releases/latest` address.

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
   - `GITHUB_ISSUES_REPO` (optional): `owner/repo` for automatic bug reports (see "Automatic bug reports").
   - `MAIL_FROM`, `SUPPORT_ADDRESS`, `SUPPORT_FORWARD_TO`: email (see "Email").

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

- **HTTPS (`TCP 443`):** To `<organization>.labkiosk.yourdomain.com` (the control channel, enrollment, Remote Control sessions, and web pages). The control channel is a long-lived WebSocket; a proxy that refuses WebSocket upgrades only costs efficiency, because the agent falls back to the 3-second HTTPS heartbeat after three failed attempts.
- **DNS (`UDP/TCP 53`):** To organization DNS servers or public resolvers (`1.1.1.1`, `8.8.8.8`).

### Network Addressing & Proxy Architecture

- **Ethernet & Wi-Fi:** Workstations support standard DHCP (IPv4 & IPv6), Custom DNS overrides (`ignore-auto-dns yes`), or fixed Static IPs configured via the setup wizard.
- **HTTP / HTTPS Proxy:** Organization districts operating transparent or explicit proxy servers (e.g. Squid, Lightspeed, Smoothwall, Fortinet) can specify the proxy host and port during setup. Settings are stored in `/etc/labkiosk/proxy.json` (persisted on the data partition), applied to the agent's own requests, and enforced in Chromium managed policy (`ProxySettings` with `ProxyMode: "fixed_servers"`). Loopback is always exempt.
- **Persistence:** All network configurations and Wi-Fi credentials are saved to the persistent `LABKIOSK_DATA` partition and bind-mounted on boot, surviving `overlayroot="tmpfs"` reboots.
