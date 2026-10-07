# Database Schema

Lab Kiosk stores everything durable in **Cloudflare D1** (SQLite at the edge). Live state -- who is connected, the command queue, screen frames -- belongs to each organization's OrgHub Durable Object, which writes back to `client_devices` here; audit entries older than 180 days move to R2.

---

## The schema has two homes

This is the single most important rule when touching the database, and the test suite enforces it.

| Home | Purpose |
| :--- | :--- |
| `cloudflare-control/migrations/000N_*.sql` | What a **deployed** D1 database actually has. Applied sequentially by Wrangler. |
| `SCHEMA_SQL` in `cloudflare-control/src/db.ts` | What the **in-memory adapter** builds for tests and local development. |

Both must be changed together. `test/worker.test.ts` compares them and fails on drift with `Columns of "x" differ between SCHEMA_SQL and migrations/`.

**Never edit an applied migration.** Add a new numbered file — `0019_feature.sql` — and mirror the change in `SCHEMA_SQL`.

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
| `0006_ui_catalogs.sql` | `ui_catalogs` (platform-wide interface translations) |
| `0007_tenant_users_and_subadmins.sql` | `tenant_users` (staff delegation); `tenants.home_route`, `tunnel_domain` |
| `0008_school_homepage.sql` | `tenants.homepage_headline`, `homepage_intro`, `homepage_blocks`; moves `home_route = '/portal'` to `/home` |
| `0009_workstation_groups.sql` | `workstation_groups`; `client_devices.group_name` |
| `0010_workstation_broadcast.sql` | `client_devices.broadcast_url`, `broadcast_epoch` (a broadcast or reset addressed to selected workstations) |
| `0011_organization_vocabulary.sql` | Renames the stored roles and staff permission (`school_admin`→`org_admin`, `teacher`→`operator`, `lab_assistant`→`assistant`, `teachers`→`staff`); rebuilds the 12 tables that reference `users` cascade-safely |
| `0012_unique_workstation_group_names.sql` | Unique index on `workstation_groups(tenant_id, name COLLATE NOCASE)`; merges existing duplicates into the oldest group first |
| `0013_retire_demo_tenant.sql` | Deletes the single `demo` organization and all its rows (data only); the worker now creates `web-demo`, `local-demo` and `docker-demo` at startup |
| `0014_org_hub_live_state.sql` | Drops `commands`, `command_deliveries` and `client_devices.thumbnail` (live state moved to OrgHub); adds `tenants.online_workstations`, `custom_hostname_id`, `custom_hostname_status` |
| `0015_workstation_boot_reports.sql` | `client_devices.image_version`, `update_state`, `update_error`, `update_state_at` (boot outcomes from `POST /api/devices/boot-report`) |
| `0016_workstation_issues.sql` | `workstation_issues`: errors and warnings workstations report (Settings → Errors & Warnings), deleted after 90 days |
| `0017_bug_reports.sql` | `tenants.bug_reports_enabled`, `workstation_issues.report_state` and `bug_signature`, and the platform table `bug_reports`: opt-in automatic GitHub bug reports |
| `0018_bug_report_triage.sql` | `tenants.bug_reports_terms_version` / `_accepted_at`, `bug_reports.title`, `problem`, `status`, `pr_url`, `status_checked_at`, `workstation_issues.report_match` |

Applied migrations are never edited or renamed: wrangler tracks them by file name, which is why `0008` keeps its original name.

**`0011` rebuilds tables that other tables cascade from.** D1 cannot switch foreign keys off, and `DROP TABLE` deletes a table's rows first, firing `ON DELETE CASCADE` even with foreign-key checks deferred — a naive rebuild of `users` deletes every organization. `0011` copies every row into holding tables with no foreign keys, drops leaves first, recreates parents first and copies back with explicit column lists. **Export the database before applying it in production** (`wrangler d1 export labkiosk-db --remote --output backup.sql`).

Each migration exists because something concrete broke. Migration 0002 is worth reading in full: before it, anyone who guessed a subdomain could post screenshots and drain that organization's command queue, the allowlist was a mutable module global shared by every tenant, and broadcast commands re-executed on every three-second heartbeat.

---

## Tables

### `users`

Platform and organization administrators.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `email` | TEXT UNIQUE | |
| `password_hash` | TEXT | PBKDF2-HMAC-SHA256, 100 000 iterations, 256 bits, hex |
| `salt` | TEXT | 32 random bytes, hex |
| `role` | TEXT | `super_admin` \| `org_admin` |
| `name` | TEXT | |
| `created_at` | INTEGER | Unix seconds |

### `tenants`

One row per organization. This table has accumulated the most columns because it is where an organization's entire configuration lives.

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
| `custom_hostname_id` | TEXT | The Cloudflare for SaaS custom hostname id, once created |
| `custom_hostname_status` | TEXT | `none` \| `pending` \| `active` \| `failed` \| `local` (no provisioning in local development) |
| `online_workstations` | INTEGER | Kept by the organization's OrgHub, so the super admin list needs no query per organization |
| `bug_reports_enabled` | INTEGER | `1` when the organization opted in to automatic bug reports; default `0` |
| `bug_reports_terms_version` / `bug_reports_terms_accepted_at` | TEXT / INTEGER | The Automatic Bug Report Terms version accepted, and when; reports are sent only under the current version |
| `default_lock_message` | TEXT | Used when a `lock` command carries no message |
| `portal_title` / `portal_subtitle` / `portal_description` / `portal_footer` | TEXT | User Portal copy |
| `broadcast_url` | TEXT | Active synchronised page, or NULL |
| `broadcast_epoch` | INTEGER | Monotonic marker; `0` when no broadcast is active |
| `home_route` | TEXT | `/` (organization homepage) or `/home` (User Portal); where workstations land |
| `tunnel_domain` | TEXT | **Unused.** Was the per-organization Cloudflare Tunnel domain; Remote Control now goes through the console's relay. No longer read or written; still in the schema so the previous Worker keeps working during a deploy, and dropped by a later migration |
| `homepage_headline` / `homepage_intro` / `homepage_blocks` | TEXT | Organization homepage copy; blocks are JSON, sanitised on the way in and escaped on the way out |
| `created_at` / `updated_at` | INTEGER | |

`broadcast_url` and `broadcast_epoch` live here rather than in worker memory because isolates are per-colocation and short-lived. When they were module-level state, workstations in different colos disagreed about the current page and a recycled isolate forgot the broadcast entirely. A broadcast sent to **selected** workstations is recorded on each of their `client_devices` rows instead; the heartbeat hands a workstation whichever of the two is newer.

### `sessions`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `token` | TEXT PK | SHA-256 of the issued session token |
| `user_id` | TEXT → `users.id` | |
| `tenant_id` | TEXT → `tenants.id` | NULL for a super admin |
| `role` | TEXT | |
| `expires_at` | INTEGER | Purged hourly by `scheduled()` |

### `portal_sites`

User Portal cards.

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

The fleet registry. OrgHub writes it back on connect, disconnect, a change and every 5 minutes; who is online right now comes from the hub.

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
| `vnc_password` | TEXT | Per-boot ephemeral x11vnc secret |
| `remote_host` | TEXT | **Unused.** Was a workstation's Cloudflare Tunnel hostname; no longer read or written. Still in the schema so the previous Worker keeps working during a deploy, and dropped by a later migration |
| `group_name` | TEXT | Workstation group, matched by name to `workstation_groups.name`; NULL when ungrouped |
| `broadcast_url` | TEXT | Last broadcast addressed to this workstation alone; NULL with a non-zero epoch records a reset to the portal |
| `broadcast_epoch` | INTEGER | Orders the above against `tenants.broadcast_epoch`; the newer wins |
| `created_at` / `updated_at` | INTEGER | |
| `image_version` | TEXT | System image the last boot report named (installed disks) |
| `update_state` | TEXT | Last boot outcome reported: `installed`, `failed`, `rolled-back`, `fallback` or `error` |
| `update_error` | TEXT | The reason, for `error` |
| `update_state_at` | INTEGER | When the workstation recorded it; `0` = never. A report less than 60 s newer is ignored |

### `workstation_issues`

Errors and warnings workstations report, kept apart from `audit_logs` (which records what people
did). Fed by `POST /api/devices/boot-report`; read by Settings → Errors & Warnings; the hourly cron
deletes rows older than 90 days.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` | TEXT → `tenants.id` | `ON DELETE CASCADE` |
| `client_id` | TEXT | The workstation, from its device token |
| `severity` | TEXT | `error` or `warning` (CHECK) |
| `kind` | TEXT | `update_failed`, `update_rolled_back`, `boot_error`, `boot_fallback` |
| `image_version` | TEXT | The image the workstation was running |
| `details` | TEXT | One readable line; an `error`'s reason, cut to 300 characters |
| `occurred_at` | INTEGER | When the workstation recorded it (its clock) |
| `created_at` | INTEGER | When the Worker received it; indexed with `tenant_id` |
| `report_state` | TEXT | `none`, `pending` (recorded while the organization had opted in) or `sent` (CHECK) |
| `bug_signature` | TEXT | → `bug_reports.signature` once sent |
| `report_match` | TEXT | `new` (opened its issue) or `existing` (linked to one already filed) (CHECK) |

### `bug_reports`

One row per distinct redacted problem (signature); several signatures may share one GitHub issue
when the reasoning model matched them. Shared by every organization that reports them, with no
organization or workstation data (`src/bug_reports.ts`).

| Column | Type | Notes |
| :--- | :--- | :--- |
| `signature` | TEXT PK | SHA-256 of the kind, image version and redacted problem text |
| `kind` | TEXT | As in `workstation_issues` |
| `image_version` | TEXT | |
| `issue_number` / `issue_url` | INTEGER / TEXT | The GitHub issue |
| `created_at` | INTEGER | When it was filed |
| `title` / `problem` | TEXT | The issue title and redacted problem text the model compares new problems with |
| `status` | TEXT | `open`, `in_progress`, `pr_open`, `resolved`, `closed` (CHECK), read back from GitHub; indexed by `issue_number` |
| `pr_url` | TEXT | The pull request that references the issue |
| `status_checked_at` | INTEGER | When the status was last read |

### `device_tokens`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `token_hash` | TEXT UNIQUE | SHA-256 of the issued token. **The token itself is never stored.** |
| `tenant_id` / `client_id` | TEXT | |
| `created_at` / `last_used_at` | INTEGER | |
| `revoked` | INTEGER | Set by `/api/clients/remove` |

### `tenant_whitelist`

Per-organization permanent domain allowlist. `UNIQUE (tenant_id, domain)`.

The *effective* allowlist a workstation receives is this table unioned with every `portal_sites.domain` and, when a broadcast is active, its host. That union is computed by `buildEffectiveWhitelist()`, cached by the organization's hub and pushed to workstations when it changes; it is not stored.

### Commands (not in D1 since `0014`)

Queued commands and their per-workstation delivery receipts live in each organization's OrgHub,
in its own SQLite (`commands`, `deliveries`). A command for `"all"` records one delivery per
workstation, so a broadcast executes **exactly once** on each machine; commands expire after 60 s.

### `broadcast_presets`

Operator-defined quick-launch shortcuts: `id`, `tenant_id`, `title`, `url`, `created_at`.

### `login_attempts`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `identifier` | TEXT PK | Email or source address |
| `failed_count` | INTEGER | |
| `last_failed_at` | INTEGER | |
| `locked_until` | INTEGER | Exponential back-off; drives `429` |

### `ui_catalogs`

Interface translations for the setup wizard and kiosk bar. **No `tenant_id`, on purpose**: the text is the same for every organization, and a workstation fetches it before it is enrolled. Written only by a super admin.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `tag` | TEXT PK | BCP 47 language tag, e.g. `hi-IN` |
| `name` / `direction` | TEXT | Display name; `ltr` or `rtl` |
| `body` | TEXT | Sanitised flat JSON map of key to string |
| `entry_count` | INTEGER | |
| `updated_at` / `updated_by` | INTEGER / TEXT | |

### `tenant_users`

Staff accounts delegated by an organization.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` / `user_id` | TEXT | Unique together; both `ON DELETE CASCADE` |
| `role` | TEXT | `org_admin` \| `sub_admin` \| `operator` \| `assistant` \| `content_manager` (default `operator`) |
| `permissions` | TEXT | JSON array of `workstations`, `broadcast`, `portal`, `whitelist`, `staff`, `settings`; `*` is never stored |
| `created_at` | INTEGER | |

An `org_admin` row, or owning the organization (`tenants.user_id`), means full access. A delegate holding `staff` can grant only what they hold themselves and cannot appoint an `org_admin`.

### `workstation_groups`

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` | TEXT → `tenants.id` | `ON DELETE CASCADE` |
| `name` | TEXT | 1–50 characters, unique per organization case-insensitively (index `idx_workstation_groups_tenant_name`; membership is by name) |
| `created_at` | INTEGER | |

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
idx_device_tokens_tenant           device_tokens(tenant_id, client_id)
idx_tenant_whitelist_tenant        tenant_whitelist(tenant_id)
idx_broadcast_presets_tenant       broadcast_presets(tenant_id)
idx_audit_logs_tenant              audit_logs(tenant_id, created_at)
idx_workstation_issues_tenant      workstation_issues(tenant_id, created_at)
idx_bug_reports_issue              bug_reports(issue_number)   -- platform table, no tenant_id
```

Every index leads with `tenant_id` wherever the table is tenant-scoped, matching the query shape that `db.ts` always uses.

---

## Adding a schema change

1. Create `migrations/0019_<description>.sql` (the next number after `0018`). Use `ALTER TABLE` for new columns; D1 has SQLite's limitations, so plan for additive changes.
2. Mirror the change in `SCHEMA_SQL` in `src/db.ts`.
3. Make sure any new query filters by `tenant_id`.
4. Run `pnpm --prefix cloudflare-control test`. The drift test will tell you if the two homes disagree.
5. Apply locally with `--local`, and in production with `--remote` — the deploy workflow does this automatically before `wrangler deploy`.

---

## Local testing engine

`src/d1_adapter.ts` implements the D1 interface on top of Node 22's native `node:sqlite`, with no npm dependency. Tests run against it with `ALLOW_LOCAL_DB=1`; without that flag a missing D1 binding is a hard failure rather than silent data loss.

> **Windows note:** Miniflare's `db.exec()` mis-parses multiline SQL with CRLF line endings, producing `D1_EXEC_ERROR: incomplete input`. The adapter splits statements on `;`, normalises `\r\n` to `\n`, and runs each through `db.prepare(stmt).run()`.

→ [Control Plane Internals](Control-Plane-Internals) · [Testing Guide](Testing-Guide)
