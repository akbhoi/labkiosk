# Database Schema

Lab Kiosk stores everything durable in **Cloudflare D1** (SQLite at the edge). There are no other data stores; the worker's in-memory telemetry cache is an optimisation that may be empty at any moment.

---

## The schema has two homes

This is the single most important rule when touching the database, and the test suite enforces it.

| Home | Purpose |
| :--- | :--- |
| `cloudflare-control/migrations/000N_*.sql` | What a **deployed** D1 database actually has. Applied sequentially by Wrangler. |
| `SCHEMA_SQL` in `cloudflare-control/src/db.ts` | What the **in-memory adapter** builds for tests and local development. |

Both must be changed together. `test/worker.test.ts` compares them and fails on drift with `Columns of "x" differ between SCHEMA_SQL and migrations/`.

**Never edit an applied migration.** Add a new numbered file — `0006_feature.sql` — and mirror the change in `SCHEMA_SQL`.

```bash
# Local
npx wrangler d1 migrations apply labkiosk-db --local

# Production
npx wrangler d1 migrations apply labkiosk-db --remote
```

A worker with a D1 binding refuses to serve a database whose migrations have not been applied (`assertSchemaCurrent()`), and never creates tables at runtime.

---

## Migration history

| File | What it added |
| :--- | :--- |
| `0001_initial_schema.sql` | `users`, `tenants`, `sessions`, `portal_sites`, `client_devices`, `commands`, `audit_logs` |
| `0002_device_enrolment_and_scoped_whitelist.sql` | `device_tokens`, `tenant_whitelist`, `command_deliveries`, `login_attempts`; `tenants.enrollment_key` |
| `0003_custom_domains.sql` | `tenants.custom_domain`, `requested_custom_domain`, `custom_domain_status` |
| `0004_customization_and_presets.sql` | `broadcast_presets`; `tenants.default_lock_message`, `portal_title`, `portal_subtitle`, `portal_description`, `portal_footer` |
| `0005_broadcast_state_and_remote_control.sql` | `tenants.broadcast_url`, `broadcast_epoch`; `client_devices.vnc_password`, `remote_host` |

Each migration exists because something concrete broke. Migration 0002 is worth reading in full: before it, anyone who guessed a subdomain could post screenshots and drain that school's command queue, the allowlist was a mutable module global shared by every tenant, and broadcast commands re-executed on every three-second heartbeat.

---

## Tables

### `users`

Platform and school administrators.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `email` | TEXT UNIQUE | |
| `password_hash` | TEXT | PBKDF2-HMAC-SHA256, 100 000 iterations, 256 bits, hex |
| `salt` | TEXT | 32 random bytes, hex |
| `role` | TEXT | `super_admin` \| `school_admin` |
| `name` | TEXT | |
| `created_at` | INTEGER | Unix seconds |

### `tenants`

One row per school. This table has accumulated the most columns because it is where a school's entire configuration lives.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `user_id` | TEXT → `users.id` | Owning administrator, `ON DELETE CASCADE` |
| `name` | TEXT | Display name; attacker-controlled, always escaped on render |
| `subdomain` | TEXT UNIQUE | The slug in `<slug>.labkiosk.example.edu` |
| `requested_subdomain` | TEXT | Pending change awaiting super-admin action |
| `status` | TEXT | `active` \| `pending` \| `rejected` \| `suspended` |
| `mode` | TEXT | `portal` \| `single_url` |
| `default_url` | TEXT | Target in `single_url` mode |
| `admin_pin` | TEXT | Legacy local PIN, default `1234` |
| `enrollment_key` | TEXT | Empty by default — an empty key authenticates nothing |
| `custom_domain` | TEXT | Approved FQDN; unique index |
| `requested_custom_domain` | TEXT | Awaiting approval |
| `custom_domain_status` | TEXT | `none` \| `pending` \| `approved` \| `rejected` |
| `default_lock_message` | TEXT | Used when a `lock` command carries no message |
| `portal_title` / `portal_subtitle` / `portal_description` / `portal_footer` | TEXT | Student portal copy |
| `broadcast_url` | TEXT | Active synchronised lesson, or NULL |
| `broadcast_epoch` | INTEGER | Monotonic marker; `0` when no broadcast is active |
| `created_at` / `updated_at` | INTEGER | |

`broadcast_url` and `broadcast_epoch` live here rather than in worker memory because isolates are per-colocation and short-lived. When they were module-level state, workstations in different colos disagreed about the current lesson and a recycled isolate forgot the broadcast entirely.

### `sessions`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `token` | TEXT PK | SHA-256 of the issued session token |
| `user_id` | TEXT → `users.id` | |
| `tenant_id` | TEXT → `tenants.id` | NULL for a super admin |
| `role` | TEXT | |
| `expires_at` | INTEGER | Purged hourly by `scheduled()` |

### `portal_sites`

Student Learning Portal cards.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` | TEXT → `tenants.id` | Every query filters on this |
| `title` / `url` / `domain` | TEXT | `domain` is what feeds the effective allowlist |
| `category` | TEXT | Default `General` |
| `icon` / `thumbnail_url` | TEXT | Optional |
| `order_index` | INTEGER | Display order |
| `is_active` | INTEGER | `0` or `1` |
| `created_at` | INTEGER | |

### `client_devices`

The fleet, and the source of truth behind the dashboard.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | Composite `tenant_id:client_id` |
| `tenant_id` | TEXT → `tenants.id` | |
| `client_id` | TEXT | e.g. `PC-01` |
| `client_num` | INTEGER | Workstation number |
| `ip` | TEXT | Source address of the last heartbeat |
| `last_seen` | INTEGER | Drives the online/offline indicator |
| `is_locked` | INTEGER | |
| `active_url` | TEXT | |
| `thumbnail` | TEXT | Latest base64 JPEG, ≤ 256 KB |
| `vnc_password` | TEXT | Per-boot ephemeral x11vnc secret |
| `remote_host` | TEXT | Cloudflare Tunnel hostname for noVNC |
| `created_at` / `updated_at` | INTEGER | |

### `device_tokens`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `token_hash` | TEXT UNIQUE | SHA-256 of the issued token. **The token itself is never stored.** |
| `tenant_id` / `client_id` | TEXT | |
| `created_at` / `last_used_at` | INTEGER | |
| `revoked` | INTEGER | Set by `/api/clients/remove` |

### `tenant_whitelist`

Per-school permanent domain allowlist. `UNIQUE (tenant_id, domain)`.

The *effective* allowlist a workstation receives is this table unioned with every `portal_sites.domain` and, when a broadcast is active, its host. That union is computed per heartbeat by `buildEffectiveWhitelist()` and is not stored.

### `commands`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` | TEXT → `tenants.id` | |
| `target` | TEXT | `"all"` or a specific `client_id` |
| `action` | TEXT | One of the seven supported actions |
| `payload_json` | TEXT | `url`, `message`, `epoch` |
| `created_at` / `expires_at` | INTEGER | Rows are short-lived by design and purged opportunistically |

### `command_deliveries`

`PRIMARY KEY (command_id, client_id)`. A receipt per workstation per command, so a broadcast executes **exactly once** on each machine instead of on every three-second heartbeat.

### `broadcast_presets`

Teacher-defined quick-launch shortcuts: `id`, `tenant_id`, `title`, `url`, `created_at`.

### `login_attempts`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `identifier` | TEXT PK | Email or source address |
| `failed_count` | INTEGER | |
| `last_failed_at` | INTEGER | |
| `locked_until` | INTEGER | Exponential back-off; drives `429` |

### `audit_logs`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` | TEXT → `tenants.id` | `ON DELETE SET NULL` — the log outlives the tenant |
| `user_id` | TEXT → `users.id` | `ON DELETE SET NULL` |
| `action` | TEXT | e.g. `command.lock`, `settings.mode` |
| `details` | TEXT | e.g. `target=all url=https://…` |
| `created_at` | INTEGER | |

---

## Indices

```sql
idx_tenants_subdomain              tenants(subdomain)
idx_tenants_status                 tenants(status)
idx_tenants_custom_domain          tenants(custom_domain)          -- UNIQUE
idx_tenants_custom_domain_status   tenants(custom_domain_status)
idx_sessions_user_id               sessions(user_id)
idx_sessions_expires_at            sessions(expires_at)
idx_portal_sites_tenant            portal_sites(tenant_id, order_index)
idx_client_devices_tenant          client_devices(tenant_id)
idx_commands_tenant_target         commands(tenant_id, target, expires_at)
idx_device_tokens_tenant           device_tokens(tenant_id, client_id)
idx_tenant_whitelist_tenant        tenant_whitelist(tenant_id)
idx_command_deliveries_client      command_deliveries(client_id, delivered_at)
idx_broadcast_presets_tenant       broadcast_presets(tenant_id)
idx_audit_logs_tenant              audit_logs(tenant_id, created_at)
```

Every index leads with `tenant_id` wherever the table is tenant-scoped, matching the query shape that `db.ts` always uses.

---

## Adding a schema change

1. Create `migrations/0006_<description>.sql`. Use `ALTER TABLE` for new columns; D1 has SQLite's limitations, so plan for additive changes.
2. Mirror the change in `SCHEMA_SQL` in `src/db.ts`.
3. Make sure any new query filters by `tenant_id`.
4. Run `pnpm --prefix cloudflare-control test`. The drift test will tell you if the two homes disagree.
5. Apply locally with `--local`, and in production with `--remote` — the deploy workflow does this automatically before `wrangler deploy`.

---

## Local testing engine

`src/d1_adapter.ts` implements the D1 interface on top of Node 22's native `node:sqlite`, with no npm dependency. Tests run against it with `ALLOW_LOCAL_DB=1`; without that flag a missing D1 binding is a hard failure rather than silent data loss.

> **Windows note:** Miniflare's `db.exec()` mis-parses multiline SQL with CRLF line endings, producing `D1_EXEC_ERROR: incomplete input`. The adapter splits statements on `;`, normalises `\r\n` to `\n`, and runs each through `db.prepare(stmt).run()`.

→ [Control Plane Internals](Control-Plane-Internals) · [Testing Guide](Testing-Guide)
