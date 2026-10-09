# Super Admin Guide

The Super Admin Master Console at `/super` on the platform apex — `https://labkiosk.<your-domain>/super`. This is the platform operator's console, not an organization's.

Sign in with `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. There is no default super admin: with a D1 binding present, the worker **refuses to serve at all** if either secret is unset.

---

## What a super admin can do

| Capability | Why it is reserved |
| :--- | :--- |
| Approve or reject organization registrations | Anyone can register; nothing works until a human approves |
| Suspend or reactivate an organization | The platform's kill switch |
| Approve, reject, or remove custom domains | Binding an FQDN to a tenant is a routing decision |
| Open the platform's demo organizations (`web-demo`, `local-demo`, `docker-demo`) | Testing the platform without reaching into a real organization's data |
| Read and answer the platform's mail and requests (**Tasks**, **Mail**) | Registrations, Remote Control requests and every message sent to an address on the mail domain |

A super-admin session may use `?tenant=<slug>` and `X-Tenant` on any host — one of only four cases where the `Host` header is not the sole authority — but `requireTenantAdmin()` then lets it into an organization's console or API **only** for one of the three demos it owns (`isDemoTenant()` in `src/demo.ts`: a demo slug *and* owned by the super admin). Any other organization answers `403` ("Platform administrators cannot access individual organization consoles"), and its `/admin` page explains the privacy isolation and points to `/super`. Opening `/admin/*` with no organization named lands in `local-demo` on a development host and `web-demo` otherwise. The demo slugs, and the retired `demo`, cannot be registered by an organization. → [Architecture Overview](Architecture-Overview#tenant-resolution)

A super admin cannot read organization passwords. They are PBKDF2 digests with per-user salts.

---

## Tenant lifecycle

```text
         register
            |
            v
      +-----------+   approve    +----------+   suspend    +-----------+
      |  pending  | -----------> |  active  | -----------> | suspended |
      +-----------+              +----------+ <----------- +-----------+
            |                                  reactivate
            | reject
            v
      +-----------+
      | rejected  |
      +-----------+
```

| Status | Portal | Dashboard | Enrolment | Telemetry |
| :--- | :--- | :--- | :--- | :--- |
| `pending` | ✗ | sign-in only | ✗ | ✗ |
| `active` | ✓ | ✓ | ✓ | ✓ |
| `suspended` | ✗ | ✗ | ✗ | `403` |
| `rejected` | ✗ | ✗ | ✗ | ✗ |

### Approving an organization

```json
POST /api/super/tenants/approve
{ "tenantId": "tenant-uuid-1", "subdomain": "oakridge" }
```

Before approving, check that the subdomain is plausible for the organization, that it is not a [reserved slug](Configuration-Reference#reserved-subdomains), and that the admin email belongs to that organization's domain.

On approval the organization can sign in, configure its portal, generate an enrollment key, and enrol workstations.

### Rejecting

```json
POST /api/super/tenants/reject
{ "tenantId": "tenant-uuid-1" }
```

Frees the subdomain for someone else.

### Suspending

```json
POST /api/super/tenants/suspend
{ "tenantId": "tenant-uuid-1" }
```

Suspension takes effect on the next heartbeat, within three seconds. Every workstation gets `403`, stops receiving commands and policy, and the portal stops serving. **Nothing is deleted** — reactivation restores the organization exactly as it was, with its devices still enrolled.

Use it for non-payment, abuse, or a compromised account. It is reversible; deletion is not.

### Reactivating

```json
POST /api/super/tenants/reactivate
{ "tenantId": "tenant-uuid-1" }
```

---

## Custom domains

Organizations with their own domain can serve Lab Kiosk from `kiosk.acme.edu` rather than `acme.labkiosk.yourdomain.com`.

```text
 organization requests          you verify + approve         Cloudflare routes
 kiosk.example.com   -->   custom_domain_status:   -->  Host: kiosk.example.com
 (status: pending)         approved                    resolves to that tenant
```

### The steps

1. **Organization requests** it under Settings → Custom Domain. `requested_custom_domain` is set and `custom_domain_status` becomes `pending`.
2. **Organization creates a `CNAME`** for that hostname pointing at your platform apex.
3. **You verify** that the requesting organization actually controls the domain. The platform does not check this for you — approving a domain the requester does not own hands them traffic intended for someone else.
4. **You approve:**

   ```json
   POST /api/super/tenants/custom-domain/approve
   { "tenantId": "tenant-uuid-1", "customDomain": "kiosk.example.com" }
   ```

5. **Cloudflare** must route that hostname to the worker. With a proxied `CNAME` into your zone this is automatic; a domain in a zone you do not control needs a Cloudflare for SaaS custom hostname.

`custom_domain` carries a **unique index**, so two organizations cannot claim the same FQDN.

### Rejecting or removing

```json
POST /api/super/tenants/custom-domain/reject
POST /api/super/tenants/custom-domain/remove
```

Removing unbinds the domain; the organization reverts to its platform subdomain. Workstations enrolled against the custom domain will need re-pointing, so give notice.

---

## Subdomain change requests

An organization can request a different subdomain (`POST /api/settings/subdomain`), which lands in `requested_subdomain` for a super admin to act on. Treat it as a rename with consequences: enrolled workstations hold a `workerUrl` pointing at the old host.

---

## Platform-level secrets

| Secret | Set with | Notes |
| :--- | :--- | :--- |
| `SUPER_ADMIN_EMAIL` | `wrangler secret put` | Changing it **migrates** the super-admin account to the new address |
| `SUPER_ADMIN_PASSWORD` | `wrangler secret put` | Bootstrap credential; rotate it from inside `/super` afterwards |
| `GITHUB_ISSUES_TOKEN` | `wrangler secret put` | Optional. Fine-grained GitHub token for automatic bug reports (below) |

Once signed in, use the authenticated password-change form rather than the secret — it verifies the current password and revokes the account's other sessions.

**Never put these in a `vars` block in `wrangler.jsonc`.** A `vars` block overrides Cloudflare dashboard variables on every deploy. → [Configuration Reference](Configuration-Reference)

### Automatic bug reports

Organizations can opt in, under Settings → Errors & Warnings, to having their workstations' errors and warnings filed as redacted GitHub issues, after accepting the Automatic Bug Report Terms (`/terms/bug-reports`). The option stays unavailable to every organization until all three are set:

| Setting | What it is |
| :--- | :--- |
| `AI` | Workers AI binding, already in `wrangler.jsonc` (reasoning model `@cf/openai/gpt-oss-120b`) |
| `GITHUB_ISSUES_TOKEN` | Secret: a fine-grained token for one repository with **Issues: Read and write** (and **Pull requests: Read** for a private repository) |
| `GITHUB_ISSUES_REPO` | Dashboard variable: the repository issues are filed in, `owner/repo` |

Issues filed in a public repository are public; each organization's administrator sees the repository name before turning the option on. The terms are versioned by `BUG_REPORT_TERMS_VERSION` in `src/bug_reports.ts`: publishing a new version pauses every organization's reports until its administrator accepts it. → [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) for creating the token.

---

## Reserved subdomains

`www`, `super`, `labkiosk`, `api`, `admin`, `portal`, `status`, `mail`, `app`, `kiosk`, `root`

These can be neither registered nor resolved as an organization. Add one to `RESERVED_SLUGS` in `src/guard.ts` **before** you start using a hostname for platform purposes, not after.

---

## The console

The rail has five tabs: **Organizations** (the directory, filtered by status), **Tasks**, **Mail**, **Catalogs** and **System**. Each tab's views appear both as tabs above the content and under *Views* in the side panel. Signing in always asks for a six-digit code emailed to the super admin address; an authenticator app can be added under **System → Two-factor sign-in**.

**Tasks** holds what needs a decision: *Requests* (registrations and Remote Control requests), *Subdomain changes* and *Custom domains*.

**Mail** is the mailbox for every address on the mail domain and the contact form.

- **Folders**: Inbox (open), Unread, Read, Closed and Deleted. *Delete* moves a conversation to Deleted; from there it is restored or deleted for good. An answer from the sender brings a deleted conversation back.
- **Types**: a conversation is filed by what it is about, and its tracking ID starts with that type's prefix: `SUP` support, `SAL` sales, `BIL` billing, `LGL` legal and privacy, `GEN` general, `LTR` a letter you wrote (`REG` and `RMT` for the two kinds of task). Mail is typed by the address it was sent to. Filter by type in the side panel.
- **New message** writes as any address on the domain, as an ordinary message or a **formal letter** (dated, addressed, signed with your name and title).
- A new email from a person is answered automatically with a receipt carrying its tracking ID: once a day per sender, never to automatic mail, bounces or no-reply addresses.
- Everything sent uses one layout and a template for its purpose (`cloudflare-email-routing/src/templates/`).

---

## Hourly housekeeping

A cron trigger (`"0 * * * *"` in `wrangler.jsonc`) calls the worker's `scheduled()` handler at the top of every hour:

- Purges expired sessions.
- Cleans stale rate-limit and sign-in throttle rows.
- Moves audit entries older than 180 days to the `labkiosk-audit-archive` R2 bucket.
- Deletes workstation errors and warnings older than 90 days.
- Files incoming mail the email Worker stored but could not hand over.
- Replaces enrollment keys issued before keys carried a check character.
- Reads the newest releases from GitHub for `/download` and writes a customer-facing summary of each with Workers AI (when the `AI` binding is set; the release's own change list is shown otherwise).
- Triages pending automatic bug reports into GitHub issues, when they are set up (at most 5 GitHub writes a run), and reads back the status of up to 10 filed issues.

Commands are not in D1: each organization's OrgHub expires its own after 60 seconds.

---

## Operational checks

| Check | How |
| :--- | :--- |
| Worker is serving | `GET /api/status` on the apex |
| Migrations are current | The worker refuses to serve otherwise — a failure to boot after deploy usually means this |
| An organization's fleet is healthy | Ask its administrator: a super admin cannot open a real organization's console. The demos open with `?tenant=web-demo` (or `local-demo`, `docker-demo`) |
| Something changed unexpectedly | The organization's audit log |
| A workstation's system update failed or rolled back | The organization's Settings → Errors & Warnings (not the audit log) |

### Two failure modes worth recognising

**`SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set`** — there is no default super admin once a D1 binding exists. Set both secrets.

**`The D1 database is missing the current schema`** — run `wrangler d1 migrations apply labkiosk-db --remote`. A deployed worker never creates tables at runtime; it fails closed instead.

→ [Production Deployment](Production-Deployment) · [Configuration Reference](Configuration-Reference) · [Security Model](Security-Model)
