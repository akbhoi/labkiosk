-- Home in the kiosk bar as the end of a session.
--
-- tenants.home_reset: 1 when Home asks "Start over?" and, on Yes, signs
-- everyone out (the same wipe as the console's Clear session); 0 when it only
-- goes back to the start page. On by default, existing organizations
-- included; an administrator turns it off in Settings -> General.

ALTER TABLE tenants ADD COLUMN home_reset INTEGER NOT NULL DEFAULT 1
  CHECK (home_reset IN (0, 1));
