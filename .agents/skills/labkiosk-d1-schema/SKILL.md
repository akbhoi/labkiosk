---
name: labkiosk-d1-schema
description: Lab Kiosk Cloudflare D1 database schema and migrations — adding a migration under cloudflare-control/migrations, mirroring it in SCHEMA_SQL (src/db.ts), rebuilding a table to change a CHECK or column definition without cascade-deleting data, testing a migration on real D1, and applying migrations in production. Use for any change to tables, columns, indexes, constraints or stored values.
---

# Lab Kiosk — D1 schema & migrations

Authoritative detail: `cloudflare-control/AGENTS.md` Rules 3, 3b, 3c; reference: `wiki/Database-Schema.md`.

## The schema has two homes

- `migrations/NNNN_name.sql` is what a deployed D1 has; `SCHEMA_SQL` in `src/db.ts` builds the
  in-memory database for tests and `pnpm dev`. **Change both.**
- Add a **new** numbered file (next: `0013_…`). **Never edit or rename an applied migration** —
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

Tables that reference neither (`command_deliveries`, `login_attempts`, `ui_catalogs`) stay untouched.

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
