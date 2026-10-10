---
name: labkiosk-d1-schema
description: Lab Kiosk Cloudflare D1 database schema and migrations — adding a migration under cloudflare-control/migrations, mirroring it in SCHEMA_SQL (src/db.ts), rebuilding a table to change a CHECK or column definition without cascade-deleting data, testing a migration on real D1, and applying migrations in production. Use for any change to tables, columns, indexes, constraints or stored values.
---

# Lab Kiosk — D1 schema & migrations

Authoritative detail: `cloudflare-control/AGENTS.md` Rules 3, 3b, 3c; reference: `wiki/Database-Schema.md`.

## The schema has two homes

- `migrations/NNNN_name.sql` is what a deployed D1 has; `SCHEMA_SQL` in `src/db.ts` builds the
  in-memory database for tests and `pnpm dev`. **Change both.**
- Add a **new** numbered file (next: `0030_…`). **Never edit or rename an applied migration** —
  wrangler tracks them by file name, so a rename re-runs it (that is why `0008_school_homepage.sql`
  keeps its name).
- Every query that touches tenant data filters by `tenant_id`; index what you query on.
- Tests compare the two homes on the real SQLite engine: columns, types, NOT NULL, defaults,
  primary and foreign keys, indexes **including UNIQUE**, and CHECKs. (A column-only check once
  missed that `idx_tenants_custom_domain` was UNIQUE in production only.)
- `assertSchemaCurrent()` probes for the newest migration so a Worker refuses an unmigrated
  database; extend its probe when you add one. A CHECK change is invisible to a column probe —
  read `sqlite_master.sql` instead.

## Changing a CHECK or column definition on a parent table

SQLite cannot alter a constraint, D1 cannot switch foreign keys off, and **`DROP TABLE` deletes the
table's rows first — firing `ON DELETE CASCADE` even under `PRAGMA defer_foreign_keys = true`.**
Rebuilding `users` or `tenants` in place deletes every organization and session (demonstrated, not
assumed). Follow `0011_organization_vocabulary.sql`:

1. `PRAGMA defer_foreign_keys = true;`
2. `CREATE TABLE _hold_<t> AS SELECT * FROM <t>;` for the table **and every table that references
   it, transitively** (holding tables carry no foreign keys).
3. Drop **leaves first**, so nothing is dropped while a table that cascades from it still exists.
4. Recreate **parents first**, with the indexes.
5. Copy back parents first with **explicit column lists** — production column order differs from
   `SCHEMA_SQL` because later migrations appended columns — mapping values in the `SELECT`.
6. Drop the holding tables. Wrangler applies the file as one unit.

Tables that reference neither (`login_attempts`, `ui_catalogs`, `bug_reports`) stay untouched.
`workstation_issues` references `tenants` (`ON DELETE CASCADE`), so a `tenants` rebuild holds it too.

## Test a migration before it ships

- A test in `test/worker.test.ts` ("Schema sources agree") builds the database from the earlier
  migrations with foreign keys on (`migratedDb(upTo)`), seeds every affected table, applies the new
  file, and asserts identical row counts, mapped values, empty `PRAGMA foreign_key_check`, no
  leftover holding tables, and that the new CHECKs reject old values. Fence seed data that must keep
  old names with `// @vocab-keep-start … @vocab-keep-end`.
- Then on **real D1** against a **copy** of local state (never the user's own):
  ```bash
  cp -r cloudflare-control/.wrangler/state/. <scratch>/d1copy/
  npx wrangler d1 execute labkiosk-db --local --persist-to <scratch>/d1copy --file seed.sql
  npx wrangler d1 migrations apply labkiosk-db --local --persist-to <scratch>/d1copy
  npx wrangler d1 execute labkiosk-db --local --persist-to <scratch>/d1copy --command "PRAGMA foreign_key_check"
  ```
  Compare counts before and after.

## Production

```bash
npx wrangler d1 export labkiosk-db --remote --output labkiosk-backup.sql   # before any rebuild
npx wrangler d1 migrations apply labkiosk-db --remote
npx wrangler deploy                                                        # same release
```

D1 Time Travel is the second net. `pnpm dev` applies pending migrations to the local D1 on start
(`predev`); a running dev server needs a restart to see new columns.

## Messages you will meet

- `Columns of "x" differ between SCHEMA_SQL and migrations/` (or the full-schema test failing) — the
  two homes drifted; fix the side you forgot.
- `The D1 database is missing the current schema` — migrations not applied (`--remote` / `--local`).
- `D1_EXEC_ERROR: … incomplete input` — Miniflare's `db.exec()` with CRLF multi-line SQL; split on
  `;`, normalise `\r\n`, run each statement with `db.prepare(stmt).run()`.

## Current schema highlights

Roles: `users.role` `super_admin | org_admin`; `tenant_users.role` `org_admin | sub_admin | operator |
assistant | content_manager`; permissions JSON in `tenant_users.permissions`. Broadcast state:
`tenants.broadcast_url/epoch` and `client_devices.broadcast_url/epoch` (`0010`). Groups:
`workstation_groups` + `client_devices.group_name` (by name). Catalogs: `ui_catalogs` has no
`tenant_id` on purpose.

**Boot reports and bug reports** (`0015`–`0018`). `client_devices.image_version`, `update_state`,
`update_error`, `update_state_at` hold a workstation's last reported boot outcome.
`workstation_issues` (tenant-scoped; `severity` `error | warning`, `kind`, `details`) backs
Settings → Errors & Warnings, separate from `audit_logs`; the hourly cron deletes rows after
90 days. Its `report_state` (`none | pending | sent`), `bug_signature` and `report_match`
(`new | existing`) track the GitHub report. `tenants.bug_reports_enabled`,
`bug_reports_terms_version`, `bug_reports_terms_accepted_at` record the opt-in. `bug_reports`
(keyed by `signature`; `issue_number`, `issue_url`, `title`, `problem`, `status`
`open | in_progress | pr_open | resolved | closed`, `pr_url`, `status_checked_at`) is platform-wide
with **no `tenant_id` on purpose** and holds redacted text only.

**Live state is not in D1** (`0014`). The command queue (`commands`, `command_deliveries`) and
`client_devices.thumbnail` were dropped: queued commands, deliveries and who is connected live in
each organization's OrgHub (its own SQLite: `commands`, `deliveries`, `revoked`, `meta`), and
frames are relayed, never stored. `client_devices` is the **registry** the hub writes back to
(connect, disconnect, batched changes, a 5-minute refresh) — never per heartbeat.
`tenants.online_workstations` is the hub's count, for the super admin list without a query per
organization. `tenants.custom_hostname_id` / `custom_hostname_status`
(`none | pending | active | failed | local`) track the Cloudflare for SaaS hostname. `audit_logs`
keeps 180 days (`AUDIT_RETENTION_DAYS`); the hourly cron moves older rows to R2 as NDJSON.
A DO's own schema is not a D1 migration: it is created in `OrgHub`'s constructor, and changing it
needs its own versioned step there.

**Registration and the inbox** (`0020`). `tenants.remote_control_status`
(`none | pending | approved | rejected`; the demos are `approved`) gates Remote Control.
`organization_profiles` (one row per tenant) holds the registration's contact, address and billing
details and when the email and phone were verified. `email_codes` holds hashed one-time signup
codes, keyed `purpose:email`, purged hourly. `conversations` (`signup | remote_control | support`,
`tenant_id` NULL for support mail from strangers) and `conversation_messages` are the **platform's**
Tasks and Mail inbox, read only by a super admin. `conversations.mailbox` is the platform address a
mail conversation belongs to (NULL for a task); `conversation_messages.raw_key` points at the
original in R2 (`mail/<message id>.eml`) and `attachments` is its JSON attachment list.
`conversations.deleted_at` (`0022`) is when a mail conversation was moved to Deleted (NULL otherwise;
tasks are never deleted); every list and count but the `deleted` view excludes those rows.
`conversations.category` (`0024`: `registration | remote_control | support | sales | billing | legal |
general | letter`) is what it is about; it names the tracking ID's prefix and the type the console
filters by. `reference` carries that prefix (`SUP-…`), or `LK-` for a conversation from before 0024.

**Release notes** (`0025`). `release_notes` (keyed by tag) holds what GitHub published for each release
(name, date, URLs of the ISO and its checksum, the change list; `iso_sha256` since `0028`, from GitHub's
asset digest) and `summary`, a JSON list of sentences
Workers AI wrote from that list (`summary_model` says which model; NULL shows the change list instead).
A platform table like `ui_catalogs`: no `tenant_id`.

**Email codes** (`0026`). `email_codes.purpose` is a CHECK (`signup`, `contact`). A new purpose is a
rebuild of the table; it holds ten-minute codes and nothing refers to it, so `0026` drops and recreates
it instead of copying. `assertSchemaCurrent` reads the table's definition, as it does for `users`.

**Over-the-air updates** (`0027`). `releases` (keyed by `version`; `channel` `beta`/`stable`/NULL,
`kind`, `base_version`, `security_floor`, `size_bytes`, `built_at`, `manifest`, `found_at`,
`classified_at`, `classified_by`, `revoked_at`) is a platform table like `ui_catalogs`: no
`tenant_id`. `tenants.update_channel` (`stable` default, or `beta`). `client_devices.update_phase`,
`update_version`, `update_progress`, `update_detail`, `agent_version` hold what the workstation last
reported about the update it is fetching or holding (written back by OrgHub), separate from
`update_state` (0015), the outcome of its last boot. `0029` adds `tenants.security_updates`
(`next_boot` default, or `approval`; a CHECK on a new column, so a plain `ALTER TABLE`) and
`client_devices.update_kind`, `update_since`.

**Two-factor sign-in** (`0021`). `user_two_factor` (one row per user) holds the TOTP secret,
`enabled_at` (NULL while being set up), `last_totp_step` (a code works once) and the recovery codes
as a JSON list of SHA-256 hashes. `login_challenges` is a password-checked sign-in waiting for its
second factor, keyed by the SHA-256 of the browser's token, purged hourly. `user_devices` keys
browsers by `(user_id, token_hash)` for new-browser alerts and `trusted_until`.
`users.two_factor_email` (`0023`) is 1 when an organization account asked for an emailed code at
sign-in; a super admin is always emailed one, whatever the column says.
