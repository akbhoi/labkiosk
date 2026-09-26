-- Migration 0013: retire the single `demo` organization, and everything in it.
--
-- One organization used to serve every way of testing the platform -- the hosted
-- site, a local virtual machine and the Docker simulator -- so their
-- workstations, allowlists and broadcasts all landed in the same place. It is
-- replaced by three demos the worker creates at startup (web-demo, local-demo,
-- docker-demo; see src/demo.ts), and its data is not carried over.
--
-- ON DELETE CASCADE removes its sessions, portal apps, workstations, commands,
-- device tokens, allowlist, presets, staff links and groups. Two tables are
-- cleared by hand first, because the cascade does not reach them:
--   * audit_logs is ON DELETE SET NULL, which would leave the demo's history
--     behind as tenant-less rows -- the platform's own history view;
--   * command_deliveries has no foreign key at all.
--
-- User accounts are kept: the demo's owner is the platform super admin.
-- `demo` stays reserved (isReservedSlug), so nobody can register it afterwards.
-- No schema change, so SCHEMA_SQL has nothing to mirror.

DELETE FROM command_deliveries
WHERE command_id IN (
  SELECT c.id FROM commands c JOIN tenants t ON t.id = c.tenant_id WHERE t.subdomain = 'demo'
);

DELETE FROM audit_logs
WHERE tenant_id IN (SELECT id FROM tenants WHERE subdomain = 'demo');

DELETE FROM tenants WHERE subdomain = 'demo';
