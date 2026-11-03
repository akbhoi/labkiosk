-- An organization registered before phone numbers were checked by text message
-- can be sent a one-time link (src/phone_link.ts). Only the SHA-256 of the
-- link's token is kept, with when it stops working; both are cleared once the
-- number is verified.

ALTER TABLE organization_profiles ADD COLUMN phone_link_hash TEXT;
ALTER TABLE organization_profiles ADD COLUMN phone_link_expires_at INTEGER;
