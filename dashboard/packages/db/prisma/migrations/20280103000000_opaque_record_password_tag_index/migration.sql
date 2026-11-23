-- An OPAQUE record found by the keyed fingerprint of the credential hash it
-- belongs to: a password check that only has the hash (better-auth's) finds the
-- record of an account whose password exists nowhere else.
--
-- Additive, and a no-op when run again.
-- To reverse: DROP INDEX "OpaqueRecord_passwordTag_idx";
CREATE INDEX IF NOT EXISTS "OpaqueRecord_passwordTag_idx" ON "OpaqueRecord"("passwordTag");
