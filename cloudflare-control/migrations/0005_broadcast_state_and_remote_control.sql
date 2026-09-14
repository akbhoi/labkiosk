-- Lab Kiosk: durable broadcast state and per-device remote-control details
--
-- 1. The active broadcast (URL + epoch) used to live in a module-level map inside
--    the worker. Isolates are per-colocation and short-lived, so workstations in
--    different colos disagreed about the current lesson and a recycled isolate
--    forgot the broadcast entirely. It now lives on the tenant row.
-- 2. A workstation reports the x11vnc password it generated at boot and the
--    Cloudflare Tunnel hostname it is reachable on, so the teacher console can
--    open a remote-control session without either being configured by hand.

ALTER TABLE tenants ADD COLUMN broadcast_url TEXT;
ALTER TABLE tenants ADD COLUMN broadcast_epoch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE client_devices ADD COLUMN vnc_password TEXT;
ALTER TABLE client_devices ADD COLUMN remote_host TEXT;
