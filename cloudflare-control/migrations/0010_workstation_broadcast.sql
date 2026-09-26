-- Per-workstation broadcast state
--
-- A broadcast sent to selected workstations used to exist only as a queued
-- navigate command. The next heartbeat answered with the school-wide target (the
-- portal), and the workstation went back to it within one 3-second heartbeat.
-- Each workstation now keeps the last broadcast (or reset) addressed to it; the
-- heartbeat hands out whichever of this and the school-wide broadcast is newer.
-- broadcast_url NULL with a non-zero epoch records a reset to the portal.

ALTER TABLE client_devices ADD COLUMN broadcast_url TEXT;
ALTER TABLE client_devices ADD COLUMN broadcast_epoch INTEGER NOT NULL DEFAULT 0;
