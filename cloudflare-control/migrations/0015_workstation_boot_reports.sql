-- 0015: what each workstation's last boot did with its system image.
--
-- An installed workstation boots a new image once and keeps it only if the
-- health check passes (docs/OTA_UPDATES.md §5.6). The agent reports the outcome
-- with POST /api/devices/boot-report; the latest one is kept here and each new
-- one is written to the organization's audit log.
--
--   image_version     the image the workstation is running
--   update_state      installed | failed | rolled-back | fallback | error
--   update_error      the reason, for `error`
--   update_state_at   when the workstation recorded it (its own clock, seconds)
--
-- ALTER TABLE ... ADD COLUMN does not rebuild the table, so nothing cascades (Rule 3b).

ALTER TABLE client_devices ADD COLUMN image_version TEXT;
ALTER TABLE client_devices ADD COLUMN update_state TEXT;
ALTER TABLE client_devices ADD COLUMN update_error TEXT;
ALTER TABLE client_devices ADD COLUMN update_state_at INTEGER NOT NULL DEFAULT 0;
