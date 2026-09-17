-- Game server players tied to a Polaris account, whose allowed addresses follow
-- that account's sign-ins, and which access rows Polaris keeps in step.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "GamePlayerAccess" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS "GamePlayerLink" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "player" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GamePlayerLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GamePlayerLink_installedAppId_player_key" ON "GamePlayerLink"("installedAppId", "player");
CREATE INDEX IF NOT EXISTS "GamePlayerLink_installedAppId_idx" ON "GamePlayerLink"("installedAppId");
CREATE INDEX IF NOT EXISTS "GamePlayerLink_userId_idx" ON "GamePlayerLink"("userId");
