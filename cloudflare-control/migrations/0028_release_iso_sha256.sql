-- /download shows each release's ISO checksum as text, not only as a link to
-- the .sha256 file. GitHub computes the SHA-256 of every asset it stores; the
-- release notes run keeps the ISO's (src/release_notes.ts). NULL until the
-- next run reads the release again, and for a release GitHub has no digest for.

ALTER TABLE release_notes ADD COLUMN iso_sha256 TEXT;
