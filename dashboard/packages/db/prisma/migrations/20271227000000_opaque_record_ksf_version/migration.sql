-- The Argon2id profile an OPAQUE record was made with. Existing records were
-- all made with profile 1, which the default gives them; additive and rerunnable.
ALTER TABLE "OpaqueRecord" ADD COLUMN IF NOT EXISTS "ksfVersion" INTEGER NOT NULL DEFAULT 1;
