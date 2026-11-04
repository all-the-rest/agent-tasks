-- Public sign-up did not require e-mail verification before this release. Those
-- accounts could not sign in once requireEmailVerification became active, so the
-- upgrade marks the already-provisioned accounts verified exactly once. Accounts
-- created after this migration still start unverified and must use the mailed link.
UPDATE "user" SET email_verified = true WHERE email_verified = false;
