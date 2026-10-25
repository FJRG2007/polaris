-- Games played without a call: a session may have no meeting (a lobby), and
-- the people invited to one are remembered until the invitation expires.
-- Additive: one column loses NOT NULL, one table and two indexes are new.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: DROP TABLE "ArcadeInvite"; DROP INDEX
-- "ArcadeSessionPlayer_userId_leftAt_idx"; DELETE FROM "ArcadeSession" WHERE
-- "meetingId" IS NULL; ALTER TABLE "ArcadeSession" ALTER COLUMN "meetingId"
-- SET NOT NULL.
ALTER TABLE "ArcadeSession" ALTER COLUMN "meetingId" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "ArcadeSessionPlayer_userId_leftAt_idx" ON "ArcadeSessionPlayer"("userId", "leftAt");

CREATE TABLE IF NOT EXISTS "ArcadeInvite" (
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "invitedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "declinedAt" TIMESTAMP(3),
    CONSTRAINT "ArcadeInvite_pkey" PRIMARY KEY ("sessionId", "userId")
);

CREATE INDEX IF NOT EXISTS "ArcadeInvite_userId_expiresAt_idx" ON "ArcadeInvite"("userId", "expiresAt");

ALTER TABLE "ArcadeInvite" DROP CONSTRAINT IF EXISTS "ArcadeInvite_sessionId_fkey";
ALTER TABLE "ArcadeInvite" ADD CONSTRAINT "ArcadeInvite_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "ArcadeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
