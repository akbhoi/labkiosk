-- Two-step signup (src/signup.ts): the account first, then, signed in, the
-- organization's name, address and tax ID. Until the second step the console,
-- enrolment and billing stay closed.
--
-- The profile's address columns stay NOT NULL: an account that has not entered
-- them stores empty text, and this column says whether they are entered.
ALTER TABLE tenants ADD COLUMN profile_completed_at INTEGER;

-- Every organization registered before this entered its details in one form.
UPDATE tenants SET profile_completed_at = created_at;

-- One organization per contact email and per phone number. Checked by the
-- registration rather than a UNIQUE index, because organizations registered
-- before the rule may already share one.
CREATE INDEX IF NOT EXISTS idx_organization_profiles_email ON organization_profiles(contact_email);
CREATE INDEX IF NOT EXISTS idx_organization_profiles_phone ON organization_profiles(contact_phone);
