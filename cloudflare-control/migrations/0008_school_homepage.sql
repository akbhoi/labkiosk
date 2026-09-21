-- School homepage.
--
-- The subdomain root used to serve the student app grid, the same page as
-- /home and /portal. It now serves a homepage the school controls: a headline,
-- a short introduction, and a list of content blocks (a notice, a link to the
-- school's own site, a timetable note). The grid moves to /home alone.
--
-- Nothing here is required. A school that edits none of it gets a page built
-- from its name and its existing portal copy.

ALTER TABLE tenants ADD COLUMN homepage_headline TEXT;
ALTER TABLE tenants ADD COLUMN homepage_intro TEXT;

-- A JSON array of { title, body, url } objects. SQLite has no array type and
-- the list is small, read whole and written whole, so a separate table would
-- buy nothing. It is validated and size-capped before it is stored, and every
-- field is escaped on the way out: a block is school-supplied text rendered on
-- a page students load.
ALTER TABLE tenants ADD COLUMN homepage_blocks TEXT;

-- /portal is gone, and a school could point its workstations at it from Lab
-- Settings ("/portal (Portal Direct)"). Those machines would reset to a 404,
-- so move them to the path that now serves the grid.
UPDATE tenants SET home_route = '/home' WHERE home_route = '/portal';
