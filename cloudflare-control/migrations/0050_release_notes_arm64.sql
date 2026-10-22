-- The arm64 ISO of a release, for /download, beside amd64's (iso_url and the
-- columns 0025 and 0028 added). NULL for every release before arm64.

ALTER TABLE release_notes ADD COLUMN arm64_iso_url TEXT;
ALTER TABLE release_notes ADD COLUMN arm64_checksum_url TEXT;
ALTER TABLE release_notes ADD COLUMN arm64_iso_bytes INTEGER;
ALTER TABLE release_notes ADD COLUMN arm64_iso_sha256 TEXT;
