-- A single-use pass for the "new sign-ins need approval" gate. Arming or
-- disabling an authenticator replaces the session it was done from, and the
-- replacement was being read as a new sign-in and held for approval. The pass is
-- issued by the session that is about to be replaced, bound to its address, and
-- consumed by the first request the replacement makes.
ALTER TABLE "UserSecurity" ADD COLUMN "rotationGraceUntil" TIMESTAMP(3);
ALTER TABLE "UserSecurity" ADD COLUMN "rotationGraceIp" TEXT;
