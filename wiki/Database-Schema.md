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

**Never edit an applied migration.** Add a new numbered file — `0034_feature.sql` — and mirror the change in `SCHEMA_SQL`.

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
| `0019_drop_remote_tunnel_columns.sql` | Drops `tenants.tunnel_domain` and `client_devices.remote_host` (Remote Control now runs through the console relay) |
| `0020_signup_approvals_support.sql` | Registration review and the platform inbox: `tenants.remote_control_status`, `organization_profiles`, `email_codes`, `conversations`, `conversation_messages` |
| `0021_two_factor.sql` | `user_two_factor` (authenticator app, recovery codes), `login_challenges`, `user_devices` (new-browser alerts, trusted browsers) |
| `0022_mail_deleted.sql` | `conversations.deleted_at`: Mail's Deleted folder (delete moves there first) |
| `0023_two_factor_email.sql` | `users.two_factor_email`: an organization account asked for an emailed sign-in code (a super admin is always asked) |
| `0024_conversation_category.sql` | `conversations.category`: what a conversation is about, which names its tracking ID's prefix (`REG`, `RMT`, `SUP`, `SAL`, `BIL`, `LGL`, `GEN`, `LTR`) |
| `0025_release_notes.sql` | `release_notes`: each GitHub release with its change list and a summary written for customers, for `/download`. A platform table, no `tenant_id` |
| `0026_contact_email_code.sql` | `email_codes` rebuilt so its `purpose` also allows `contact`: the contact page proves its sender's address with a code, as registration does |
| `0027_ota_updates.sql` | Over-the-air updates: the platform table `releases`; `tenants.update_channel`; `client_devices.update_phase`, `update_version`, `update_progress`, `update_detail`, `agent_version` |
| `0028_release_iso_sha256.sql` | `release_notes.iso_sha256`: the ISO's SHA-256 as GitHub computed it, shown as text on `/download` |
| `0029_security_updates.sql` | Security releases at the next boot: `tenants.security_updates`; `client_devices.update_kind`, `update_since` |
| `0030_lan_sharing.sql` | `tenants.lan_sharing`: the workstations at one site copy a release from each other instead of each downloading it |
| `0031_restart_logs.sql` | `workstation_issues.log_text`: the end of the journal a restart report carried, cleared after 30 days |
| `0032_workstation_limit.sql` | `tenants.workstation_limit`: how many workstations an organization may enrol (45 by default, or what it already had when more) |
| `0033_remote_control_seats.sql` | `tenants.remote_control_seats` (concurrent sessions; 5 for organizations already approved, 1 for new approvals) and `remote_control_revoked_at` |
| `0034_release_lines.sql` | The platform tables `release_lines` (each line's support status and end-of-life date) and `release_majors` (whether a major is open), and `major_upgrade_grants` (a closed major granted to one organization, and its administrator's confirmation) |
| `0035_legal_acceptances.sql` | `legal_acceptances` (append-only, no foreign keys: who accepted which version of which legal document, when, from where) and `legal_versions` (when each version was first served) |
| `0036_hosted_content.sql` | `link_blocklist` (domains no hosted page may link to); `tenants.homepage_takedown_at`, `homepage_takedown_reason`; `portal_sites.takedown_at`, `takedown_reason` |
| `0037_license_plan.sql` | `tenants.license_plan` (`education`, `evaluation`, `subscriber`, `commercial`, or NULL) and `license_expires_at` |
| `0038_notifications.sql` | `notifications` and `notification_reads` (the platform's notifications in organization consoles); `release_lines.eol_reminder_days` |
| `0039_major_upgrade_pipeline.sql` | `major_upgrade_grants` gains `requested_by`/`requested_at` (an organization asked for a closed major) and `pilot_group`/`pilot_by`/`pilot_at` (the workstation group it tries a major on before confirming it) |
| `0040_release_support_per_major.sql` | `release_support`: support status and end of life per major release, replacing `release_lines` (dropped; it never reached a release, so its rows are not carried over) |

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
| `update_channel` | TEXT | `stable` (default) \| `beta`: which classified releases its workstations are offered; `beta` also takes `stable` ones |
| `security_updates` | TEXT | `next_boot` (default) \| `approval`: whether a security release for a workstation's line installs at its next start by itself, or waits for an administrator |
| `lan_sharing` | INTEGER | `1` when the organization's workstations share a release on their local network; default `0` |
| `workstation_limit` | INTEGER | How many workstations may hold a valid device token (1–100000, default 45); set by a super admin at approval and under Organizations. Enrolment past it answers 403; a workstation that still holds a valid token always enrols again |
| `remote_control_seats` | INTEGER | Remote Control sessions that may be open at once (1–1000); set when Remote Control is approved |
| `remote_control_revoked_at` | INTEGER | When a super admin revoked Remote Control (status back to `rejected`); NULL otherwise |
| `default_lock_message` | TEXT | Used when a `lock` command carries no message |
| `portal_title` / `portal_subtitle` / `portal_description` / `portal_footer` | TEXT | User Portal copy |
| `broadcast_url` | TEXT | Active synchronised page, or NULL |
| `broadcast_epoch` | INTEGER | Monotonic marker; `0` when no broadcast is active |
| `home_route` | TEXT | `/` (organization homepage) or `/home` (User Portal); where workstations land |
| `homepage_headline` / `homepage_intro` / `homepage_blocks` | TEXT | Organization homepage copy; blocks are JSON, sanitised on the way in and escaped on the way out |
| `homepage_takedown_at` / `homepage_takedown_reason` | INTEGER / TEXT | Set while a super admin has the homepage taken down (`0036`); it shows a neutral notice |
| `license_plan` | TEXT | Which grant of `LICENSE` applies: `education`, `evaluation`, `subscriber`, `commercial`; NULL until a super admin records it (`0037`) |
| `license_expires_at` | INTEGER | When the license ends (00:00 UTC of the date set); NULL for no end date. Once passed, new enrolments and Remote Control are refused; enrolled workstations keep working (`0037`, `src/license.ts`) |
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
| `takedown_at` / `takedown_reason` | INTEGER / TEXT | Set when a super admin takes the card down (`0036`); it is made inactive too |

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
| `group_name` | TEXT | Workstation group, matched by name to `workstation_groups.name`; NULL when ungrouped |
| `broadcast_url` | TEXT | Last broadcast addressed to this workstation alone; NULL with a non-zero epoch records a reset to the portal |
| `broadcast_epoch` | INTEGER | Orders the above against `tenants.broadcast_epoch`; the newer wins |
| `created_at` / `updated_at` | INTEGER | |
| `image_version` | TEXT | System image the last boot report named (installed disks) |
| `update_state` | TEXT | Last boot outcome reported: `installed`, `failed`, `rolled-back`, `fallback` or `error` |
| `update_error` | TEXT | The reason, for `error` |
| `update_state_at` | INTEGER | When the workstation recorded it; `0` = never. A report less than 60 s newer is ignored |
| `update_phase` | TEXT | What the workstation last said about the update it is fetching or holding: `live`, `idle`, `checking`, `downloading`, `ready`, `staged`, `installing`, `up-to-date` or `error`; written back by OrgHub, separate from `update_state` |
| `update_version` / `update_progress` / `update_detail` | TEXT / INTEGER / TEXT | The release that phase is about, the download's percent, and why the last attempt failed |
| `agent_version` | TEXT | The agent version the workstation reports |
| `update_kind` / `update_since` | TEXT / INTEGER | For `ready` and `staged`: the release's kind (`feature` or `security`, from its signed manifest), and since when (unix seconds) the workstation has held it in this boot |

### `workstation_issues`

Errors and warnings workstations report, kept apart from `audit_logs` (which records what people
did). Fed by `POST /api/devices/boot-report`, `POST /api/devices/restart-report` and `POST /api/devices/disk-health`; read by Settings →
Errors & Warnings; the hourly cron deletes rows older than 90 days, and restart logs after 30.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` | TEXT → `tenants.id` | `ON DELETE CASCADE` |
| `client_id` | TEXT | The workstation, from its device token |
| `severity` | TEXT | `error` or `warning` (CHECK) |
| `kind` | TEXT | `update_failed`, `update_rolled_back`, `boot_error`, `boot_fallback`, `unexpected_restart`, `watchdog_reset`, `disk_health` (one row per disk and state) |
| `image_version` | TEXT | The image the workstation was running |
| `details` | TEXT | One readable line; an `error`'s reason, cut to 300 characters |
| `occurred_at` | INTEGER | When the workstation recorded it (its clock) |
| `created_at` | INTEGER | When the Worker received it; indexed with `tenant_id` |
| `report_state` | TEXT | `none`, `pending` (recorded while the organization had opted in) or `sent` (CHECK) |
| `bug_signature` | TEXT | → `bug_reports.signature` once sent |
| `report_match` | TEXT | `new` (opened its issue) or `existing` (linked to one already filed) (CHECK) |
| `log_text` | TEXT | A restart report's journal tail (at most 16 KB); `NULL` otherwise and after 30 days |

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

### `releases`

The signed system images CI uploaded to the `RELEASES` R2 bucket, recorded when a super admin opens Super Admin → Releases. **No `tenant_id`**: releases are the platform's. A release reaches no workstation until it is classified, and a revoked one never again.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `version` | TEXT PK | e.g. `2.9.1` |
| `channel` | TEXT | `beta` \| `stable`, or NULL (not offered) |
| `kind` | TEXT | `feature` \| `security` |
| `base_version` / `security_floor` | TEXT | From the manifest |
| `size_bytes` | INTEGER | Total of the three image files |
| `built_at` | TEXT | From the manifest |
| `manifest` | TEXT | `manifest.json` as CI wrote it; workstations check its signature themselves |
| `found_at` | INTEGER | When it was recorded |
| `classified_at` / `classified_by` | INTEGER / TEXT | Last classification, and the super admin who made it |
| `revoked_at` | INTEGER | Set once, for good |

### `release_support`

A major release's support status (`0040`), covering every release of that major. **No `tenant_id`**; a major with no row is supported.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `major` | INTEGER PK | e.g. `2` for every 2.x; 0 to 9999 |
| `status` | TEXT | `supported` \| `security_only` (only its security releases, only to workstations already on it) \| `end_of_life` (nothing offered, no security rebuilds, not listed on `/download`) |
| `end_of_life_at` | INTEGER | Announced date; once passed the major is end of life whatever `status` says |
| `note` | TEXT | Shown to organizations on the major and added to the email |
| `eol_reminder_days` | INTEGER | The last end-of-life reminder sent for `end_of_life_at`: `60`, `30`, `7`, or `0` once passed; NULL when none yet. A new date resets it |
| `updated_at` / `updated_by` | INTEGER / TEXT | Last change, and the super admin who made it |

### `release_majors`

Whether a major release is open (`0034`). **No `tenant_id`.** A major with no row is offered to everyone with no confirmation, as before; the Worker adds a closed row (`open = 0`) when it records the first release of a major above every one it has.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `major` | INTEGER PK | e.g. `3` |
| `open` | INTEGER | 1: open to every organization that confirms it; 0: closed, only to organizations granted it |
| `updated_at` / `updated_by` | INTEGER / TEXT | |

### `major_upgrade_grants`

One organization's standing with a major that has a `release_majors` row (`0034`, `0039`). Its workstations are moved to that major only when it is open or granted **and** `confirmed_at` is set; before that, only the workstations of `pilot_group` are.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `tenant_id` | TEXT FK | → `tenants.id`, `ON DELETE CASCADE`; PK with `major` |
| `major` | INTEGER | |
| `granted_by` / `granted_at` | TEXT / INTEGER | The super admin who granted a closed major; NULL when it is open to all |
| `confirmed_by` / `confirmed_at` | TEXT / INTEGER | The organization's staff member (`updates` permission) who confirmed it |
| `requested_by` / `requested_at` | TEXT / INTEGER | The staff member who asked for the closed major (`0039`); a declined request deletes the row |
| `pilot_group` / `pilot_by` / `pilot_at` | TEXT / TEXT / INTEGER | The workstation group (`workstation_groups.name`) the organization tries the major on, who chose it and when (`0039`); cleared when the group is deleted |

### `legal_acceptances`

The evidence of what each organization agreed to (`0035`, `src/legal.ts`). **Append-only and without foreign keys**: nothing updates or deletes a row, and it outlives the organization and the user, so the organization's name and the user's email are copied in.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` / `tenant_name` | TEXT | The organization, and its name at the time |
| `user_id` / `user_email` | TEXT | Who accepted, and their email at the time |
| `document` | TEXT | `terms` \| `privacy` \| `aup` \| `content` |
| `version` | TEXT | The version in `LEGAL_DOCUMENTS` |
| `source` | TEXT | `registration` \| `console` |
| `accepted_at` | INTEGER | |
| `ip` / `user_agent` | TEXT | Where it came from |

### `notifications`

Notifications the platform shows in organization consoles (`0038`, `src/notifications.ts`). Columns: `id` (PK), `tenant_id` (FK, cascade; **NULL = every organization**, shown only to organizations that existed when it was written), `kind` (`general`, `account`, `release`, `legal`, `license`, `content`, `remote_control`), `title`, `body`, `created_at`, `created_by` (NULL when the platform wrote it by itself).

### `notification_reads`

Who dismissed which notification (`0038`): `notification_id` (FK, cascade), `user_id` (FK, cascade), `read_at`; PK (`notification_id`, `user_id`). Each member of staff dismisses for themselves.

### `link_blocklist`

Domains no organization homepage link or User Portal card may point to, including their subdomains (`0036`, `src/link_rules.ts`). **No `tenant_id`.** Columns: `domain` (PK), `reason`, `added_at`, `added_by`.

### `legal_versions`

When the Worker first served each document version (`0035`). An organization that has not accepted a required document's current version sees a notice in its console, and 30 days after `published_at` the console asks before anything else. `notified_at` is when a super admin last emailed organizations about it.

### `tenant_users`

Staff accounts delegated by an organization.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT PK | |
| `tenant_id` / `user_id` | TEXT | Unique together; both `ON DELETE CASCADE` |
| `role` | TEXT | `org_admin` \| `sub_admin` \| `operator` \| `assistant` \| `content_manager` (default `operator`) |
| `permissions` | TEXT | JSON array of `workstations`, `broadcast`, `portal`, `whitelist`, `staff`, `settings`, `updates`; `*` is never stored |
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

1. Create `migrations/0041_<description>.sql` (the next number after `0040`). Use `ALTER TABLE` for new columns; D1 has SQLite's limitations, so plan for additive changes.
2. Mirror the change in `SCHEMA_SQL` in `src/db.ts`.
3. Make sure any new query filters by `tenant_id`.
4. Run `pnpm --prefix cloudflare-control test`. The drift test will tell you if the two homes disagree.
5. Apply locally with `--local`, and in production with `--remote` — the deploy workflow does this automatically before `wrangler deploy`.

---

## Local testing engine

`src/d1_adapter.ts` implements the D1 interface on top of Node 22's native `node:sqlite`, with no npm dependency. Tests run against it with `ALLOW_LOCAL_DB=1`; without that flag a missing D1 binding is a hard failure rather than silent data loss.

> **Windows note:** Miniflare's `db.exec()` mis-parses multiline SQL with CRLF line endings, producing `D1_EXEC_ERROR: incomplete input`. The adapter splits statements on `;`, normalises `\r\n` to `\n`, and runs each through `db.prepare(stmt).run()`.

→ [Control Plane Internals](Control-Plane-Internals) · [Testing Guide](Testing-Guide)
