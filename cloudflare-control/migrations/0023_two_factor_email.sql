-- Two-factor sign-in by emailed code.
--
-- An account can ask for a six-digit code by email after its password, with
-- nothing to set up first; an authenticator app (0021) stays optional on top.
-- `two_factor_email` is that choice for an organization account. A super admin
-- is always asked, whatever this column says.

ALTER TABLE users ADD COLUMN two_factor_email INTEGER NOT NULL DEFAULT 0;
