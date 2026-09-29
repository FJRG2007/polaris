-- Event inventory stashes: what a player carried into an event's arena, kept in
-- the database beside the barrels that hold the game copy, so a give-back can be
-- checked and a lost barrel rebuilt.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "EventInventoryStash" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "runId" TEXT NOT NULL,
    "player" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "inventory" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "barrels" TEXT NOT NULL,
    "casing" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL,
    "note" TEXT,
    "missing" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "EventInventoryStash_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EventInventoryStash_installedAppId_status_idx" ON "EventInventoryStash"("installedAppId", "status");

CREATE INDEX IF NOT EXISTS "EventInventoryStash_runId_idx" ON "EventInventoryStash"("runId");
