# Super Admin Guide

The Super Admin Master Console at `/super` on the platform apex — `https://labkiosk.<your-domain>/super`. This is the platform operator's console, not an organization's.

Sign in with `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. There is no default super admin: with a D1 binding present, the worker **refuses to serve at all** if either secret is unset.

---

## What a super admin can do

| Capability | Why it is reserved |
| :--- | :--- |
| Approve or reject organization registrations | Anyone can register; nothing works until a human approves |
| Suspend or reactivate an organization | The platform's kill switch |
| Set how many workstations an organization may enrol (**Workstation Limit**) | The license: 45 without a paid one |
| Set Remote Control seats, revoke or restore Remote Control | An add-on the platform grants, and can take back |
| See and export which version of the Terms each organization accepted, and email those that have not | The evidence of the contract with each customer |
| Block domains on hosted pages; take an organization's homepage or a User Portal card down after a report | The platform hosts these pages under its own domain |
| Classify releases; set each major release's support status and end-of-life date; open or grant a major release | What every workstation is offered, and for how long a version is kept safe |
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

A registration is activated from **Tasks**, with a **workstation limit** (prefilled from the number the organization expects; 45 is the most the license allows without a paid one). Enrolment past it answers `403`; a workstation that still holds a valid token always enrols again, so lowering the limit later under **Organizations → ⋯ → Workstation Limit** stops new enrolments only. Each organization's row shows `N of M enrolled`, and its console header shows the same.

### Remote Control

A Remote Control request is approved from **Tasks** with a number of **seats**: how many sessions the organization may have open at once (its OrgHub counts them; one more answers `429` naming the workstations in use). Under **Organizations → ⋯**:

- **Remote Control Seats** changes that number; open sessions are not ended.
- **Revoke Remote Control** turns it off with a reason: every open session ends at once, the organization's owner is emailed the reason, and its Settings show *Turned off* with the date. The organization can ask again.
- **Restore Remote Control** turns a revoked organization back on with the seats it had. An organization that turned Remote Control off itself (Settings → Remote Control) asks again through Tasks instead.

### Security releases

Under **Releases → Security**: the daily security rebuilds, each naming the release it rebuilds. They need no classification: each is offered for download as soon as it arrives, to the workstations on its line, which install it at their next restart unless their organization approves security fixes. **Revoke** is the only action, for a rebuild that must never be installed. The rebuild covers each major's newest stable line and any newer one: once 3.1.0 is classified stable, 3.0 is rebuilt no more.

### Support, end of life and major releases

Under **Releases**, below the release lists:

- **Support and end of life**, set per major release only (2.x covers every 2.x release). **Security only** keeps sending its security fixes to the workstations already on it and moves no other workstation onto it. **End of life** offers it nothing more, security fixes included, stops the daily security rebuild building it, and takes it off the download page, which names it as ended instead (the page lists only the newest release of each major). **Set end-of-life date** announces the date it ends by itself. Each change of status or date shows every organization a notification in its console and can email every customer's owner (the ones with workstations on the major are told how many). As the date nears, every organization is reminded by itself, in its console and by email, 60, 30 and 7 days before it and once it has passed. Settings → Updates shows the organizations on the major the same warning.
- **Major releases.** The first release of a new major arrives **closed**. An organization can ask for it from Settings → Updates; its request shows in the organization's row with **Grant** and **Decline** (with a reason shown to it). **Open to all** or **Grant to an organization** (by subdomain) makes it available too. An administrator of each organization then tries it on one workstation group, and confirms it for every workstation (recorded with their name), before the rest of its workstations are moved. **Take back** removes a grant, its trial and its confirmation; workstations already on the major keep it. Each step notifies the organization in its console. Whatever the gates allow, a workstation moves one major at a time, from the newest release of its own major.

### Notifications

**System → Notifications** sends a notification to one organization or every organization: it shows at the top of their consoles until each member of staff dismisses it, and can be emailed to each owner too. The list below it shows every notification the platform has sent and how many people dismissed it. The platform notifies organizations by itself when it approves one, turns Remote Control on or off or changes its seats, changes its workstation limit or license, takes content down or restores it, grants it a major release, and when a major release changes status or nears its end of life. Sending is audited (`notification.send`).

### Legal terms

The documents in force are the Terms of Service (`/terms`, which include the Subscriber License the software license refers to), the Content Policy (`/content-policy`, part of the Terms; both are accepted), the Data Processing Agreement (`/dpa`, the platform's terms as processor under the GDPR, the UK GDPR and India's DPDP Act, with the subprocessor list; part of the Terms and accepted with them, so a change to it is a new Terms version) and the Privacy Policy (`/privacy`, acknowledged at registration). The DPA promises organizations at least 30 days' notice in their console and by email before a new subprocessor processes their data: adding an outside service that handles organization data means updating its subprocessor list, and the Privacy Policy, first. Their texts were drafted for review by a lawyer. Registration records the version of every legal document in force (`src/legal.ts`). When a document's text changes, its version changes; the first time the platform serves it, every organization that has not accepted it sees a notice in its console, and 30 days later its console asks before anything else until the owner or an `org_admin` accepts. Workstations, homepages and User Portals keep working throughout. **System → Legal** shows each document's version and how many active organizations accepted it, emails the owners of those that have not (**Email organizations**), and downloads every acceptance as CSV; **Organizations → ⋯ → Legal Record (CSV)** downloads one organization's.

### License plan and end date

**Organizations → ⋯ → License** records which grant of the license an organization runs under (*education*, *evaluation*, *subscriber* or *commercial*) and, optionally, the date it ends (00:00 UTC; *never* for none). The row shows the plan and the date. From 30 days before the end date the organization's console shows a reminder. Once it has passed the organization enrols no new workstation (a workstation that still holds a valid token enrols again) and opens no Remote Control session; its workstations, homepage and User Portal keep working, and its console says why. Renewing is setting a later date. Each change is audited (`tenant.license`), and each refused enrolment too (`device.enroll_license`).

### Hosted pages: link rules, reports and takedown

A homepage block's link and a User Portal card's address and thumbnail are refused when they use an IP address, a link shortener, a user name or password, or a domain on **System → Legal → Link blocklist** (subdomains included). Every organization homepage and User Portal has **Report this page** in its footer, which opens the contact form set to *Privacy, security or legal* with the page's address filled in; it arrives in **Mail** as a Legal (LGL) conversation.

To act on a report, use **Organizations → ⋯**: **Take Down Homepage** replaces the homepage with *This content is unavailable*; **Take Down a Portal Card** asks for the card's link and hides every card of that organization linking there. Both need a reason, which the owner is emailed and the console shows; the same link cannot be added again until it is restored. **Restore Homepage** and **Restore a Portal Card** put them back. Each step is audited (`content.takedown`, `content.restore`, `content.block`, `content.unblock`).

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

   Custom hostnames beyond the first 100 cost $0.10 a month each. The Custom domains view shows how many are in use and what they cost, and the approval says when the next one adds to the bill. A domain under the platform domain is refused: organization subdomains are already served by the wildcard.

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
| `PASSWORD_PEPPER` | `wrangler secret put` | Required. HMAC key over stored password hashes; never change or lose it |
| `SUPER_ADMIN_HOST` | Cloudflare dashboard variable | Optional. Serves this console only on that host, e.g. `super.labkiosk.org`; the wildcard route and certificate already cover it |
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

The rail has five tabs: **Organizations** (the directory, filtered by status), **Tasks**, **Mail**, **Catalogs** and **System**. Each tab's views appear both as tabs above the content and under *Views* in the side panel. Signing in always asks for a six-digit code emailed to the super admin address; passkeys and an authenticator app can be added under **System → Two-factor sign-in**, and a passkey is then offered first.

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
- Sends the end-of-life reminders now due (60, 30 and 7 days before a major's date, and once it has passed) to every organization's console and owner.
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
