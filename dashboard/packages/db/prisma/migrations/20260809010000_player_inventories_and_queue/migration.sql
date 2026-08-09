-- Inventories that outlive the session, actions that wait, and a player who
-- plays from more than one place.
--
-- Three changes with one thing in common: each was a case where Polaris could
-- only answer while the player was standing on the server.
--
--   1. An inventory read straight off the server exists only while its owner
--      does. The snapshot is what makes "what were they carrying" answerable
--      about somebody who logged off an hour ago.
--   2. Every verb the panel has was disabled the moment the player left. The
--      queue holds the decision until the server, or the player, is back.
--   3. A player was one address. Somebody who plays from home and from a laptop
--      had to pick one or open their rule to "any".

-- The name alone stops being the key: a second address for a player used to
-- overwrite the first. Every existing row already satisfies the wider key, so
-- nothing is rewritten and nothing is lost.
DROP INDEX "GamePlayerAccess_installedAppId_username_key";
CREATE UNIQUE INDEX "GamePlayerAccess_installedAppId_username_address_key"
    ON "GamePlayerAccess"("installedAppId", "username", "address");
CREATE INDEX "GamePlayerAccess_installedAppId_username_idx"
    ON "GamePlayerAccess"("installedAppId", "username");

CREATE TABLE "PlayerInventorySnapshot" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerInventorySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlayerInventorySnapshot_installedAppId_username_key"
    ON "PlayerInventorySnapshot"("installedAppId", "username");
CREATE INDEX "PlayerInventorySnapshot_installedAppId_idx"
    ON "PlayerInventorySnapshot"("installedAppId");

CREATE TABLE "PlayerActionQueue" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "needsPlayer" BOOLEAN NOT NULL DEFAULT true,
    "requestedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerActionQueue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlayerActionQueue_installedAppId_username_idx"
    ON "PlayerActionQueue"("installedAppId", "username");
CREATE INDEX "PlayerActionQueue_installedAppId_appliedAt_idx"
    ON "PlayerActionQueue"("installedAppId", "appliedAt");
CREATE INDEX "PlayerActionQueue_expiresAt_idx" ON "PlayerActionQueue"("expiresAt");
