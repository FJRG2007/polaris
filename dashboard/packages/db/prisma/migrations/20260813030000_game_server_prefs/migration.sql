-- What one person has decided about one game server, for themselves: kept at the
-- top of their list, or put away. Per viewer rather than per server - the owner
-- runs four and lives in one, somebody invited to help with that one has no
-- opinion about the other three - and a row exists only where somebody has said
-- something, so the absence of a row is the default.

CREATE TABLE "GameServerPref" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameServerPref_pkey" PRIMARY KEY ("id")
);

-- One opinion per person per server; the writer upserts on it.
CREATE UNIQUE INDEX "GameServerPref_userId_installedAppId_key" ON "GameServerPref"("userId", "installedAppId");

CREATE INDEX "GameServerPref_userId_idx" ON "GameServerPref"("userId");

-- Cleared by id when the server is deleted.
CREATE INDEX "GameServerPref_installedAppId_idx" ON "GameServerPref"("installedAppId");
