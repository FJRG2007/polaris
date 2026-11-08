-- Game rooms: a lobby opened from the Games library, with no conversation
-- around it, joined by a short code or - when public - from the list.
-- Additive: one column loses NOT NULL, two columns and two indexes are new.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: DELETE FROM "ArcadeSession" WHERE "channelId" IS NULL; DROP
-- INDEX "ArcadeSession_isPublic_endedAt_createdAt_idx"; DROP INDEX
-- "ArcadeSession_code_key"; ALTER TABLE "ArcadeSession" DROP COLUMN
-- "isPublic", DROP COLUMN "code", ALTER COLUMN "channelId" SET NOT NULL.
ALTER TABLE "ArcadeSession" ALTER COLUMN "channelId" DROP NOT NULL;

ALTER TABLE "ArcadeSession" ADD COLUMN IF NOT EXISTS "code" TEXT;
ALTER TABLE "ArcadeSession" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "ArcadeSession_code_key" ON "ArcadeSession"("code");
CREATE INDEX IF NOT EXISTS "ArcadeSession_isPublic_endedAt_createdAt_idx" ON "ArcadeSession"("isPublic", "endedAt", "createdAt");
