-- Remote Control seats and revocation.
--
-- * tenants.remote_control_seats: how many Remote Control sessions an
--   organization may have open at once, set by a super admin when approving
--   it. 1 for a new approval. Organizations already approved start with 5, so
--   nothing they do today is refused by this migration.
-- * tenants.remote_control_revoked_at: when a super admin turned Remote Control
--   off for an organization that had it (remote_control_status goes back to
--   'rejected'); NULL otherwise, and cleared when it is approved again.
--
-- Which sessions are open is live state, kept by the organization's OrgHub.

ALTER TABLE tenants ADD COLUMN remote_control_seats INTEGER NOT NULL DEFAULT 1
  CHECK (remote_control_seats BETWEEN 1 AND 1000);
ALTER TABLE tenants ADD COLUMN remote_control_revoked_at INTEGER;

UPDATE tenants SET remote_control_seats = 5 WHERE remote_control_status = 'approved';
