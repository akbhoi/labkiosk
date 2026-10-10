-- Over-the-air updates, phase 5 (docs/OTA_UPDATES.md section 5.9).
--
-- * tenants.lan_sharing: 1 when the organization lets its workstations at one
--   site copy a new system image from each other instead of each fetching it
--   from the internet. Off by default: it opens a port on the organization's
--   network while a release spreads, so an administrator chooses it.
--
-- Where each workstation is (its LAN address, the public address it connects
-- from) is live state, kept by the organization's OrgHub, not here.

ALTER TABLE tenants ADD COLUMN lan_sharing INTEGER NOT NULL DEFAULT 0
  CHECK (lan_sharing IN (0, 1));
