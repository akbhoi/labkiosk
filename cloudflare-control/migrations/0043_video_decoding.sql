-- What each workstation's GPUs decode in hardware (VA-API), as its agent read
-- it with vainfo once per start: POST /api/devices/video-decoding.
--
-- video_decoding is the validated report as JSON (parseVideoDecodingReport in
-- src/boot_report.ts); video_decoding_at is when it arrived, seconds. NULL
-- until an agent new enough to send it has started. Shown next to the
-- workstation so an administrator can see which machines play video on the
-- CPU (an NVIDIA card, a missing driver) before users notice.

ALTER TABLE client_devices ADD COLUMN video_decoding TEXT;
ALTER TABLE client_devices ADD COLUMN video_decoding_at INTEGER;
