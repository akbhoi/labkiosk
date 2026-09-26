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
| Act on any tenant via `?tenant=` | Support, without an organization sharing credentials |

A super-admin session may use `?tenant=<slug>` and `X-Tenant` on any host — one of only four cases where the `Host` header is not the sole authority. → [Architecture Overview](Architecture-Overview#tenant-resolution)

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

Once signed in, use the authenticated password-change form rather than the secret — it verifies the current password and revokes the account's other sessions.

**Never put these in a `vars` block in `wrangler.jsonc`.** A `vars` block overrides Cloudflare dashboard variables on every deploy. → [Configuration Reference](Configuration-Reference)

---

## Reserved subdomains

`www`, `super`, `labkiosk`, `api`, `admin`, `portal`, `status`, `mail`, `app`, `kiosk`, `root`

These can be neither registered nor resolved as an organization. Add one to `RESERVED_SLUGS` in `src/guard.ts` **before** you start using a hostname for platform purposes, not after.

---

## Hourly housekeeping

A cron trigger (`"0 * * * *"` in `wrangler.jsonc`) calls the worker's `scheduled()` handler at the top of every hour:

- Purges expired sessions.
- Deletes delivered and acknowledged commands.
- Cleans stale rate-limit and sign-in throttle rows.

Command rows are short-lived by design and are also purged opportunistically on dispatch, so the queue does not depend on the cron alone.

---

## Operational checks

| Check | How |
| :--- | :--- |
| Worker is serving | `GET /api/status` on the apex |
| Migrations are current | The worker refuses to serve otherwise — a failure to boot after deploy usually means this |
| An organization's fleet is healthy | Sign in with `?tenant=<slug>` and look at `last_seen` across the grid |
| Something changed unexpectedly | The organization's audit log |

### Two failure modes worth recognising

**`SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set`** — there is no default super admin once a D1 binding exists. Set both secrets.

**`The D1 database is missing the current schema`** — run `wrangler d1 migrations apply labkiosk-db --remote`. A deployed worker never creates tables at runtime; it fails closed instead.

→ [Production Deployment](Production-Deployment) · [Configuration Reference](Configuration-Reference) · [Security Model](Security-Model)
