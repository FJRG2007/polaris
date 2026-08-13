-- A server somebody already built, kept so they can build that one again. The
-- blueprints are Polaris's and the same for everybody; this belongs to one person
-- and holds only the settings that ended up differing from what the blueprint
-- would have given it.

CREATE TABLE "ServerTemplate" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "game" TEXT NOT NULL,
    "edition" TEXT NOT NULL DEFAULT 'java',
    "blueprintId" TEXT NOT NULL DEFAULT '',
    "mapId" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT 'LATEST',
    "env" TEXT NOT NULL DEFAULT '{}',
    "concurrentPlayers" INTEGER NOT NULL DEFAULT 8,
    "crossplay" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServerTemplate_ownerId_idx" ON "ServerTemplate"("ownerId");

-- One name per person: a list of four things called "test" is a list nobody can use.
CREATE UNIQUE INDEX "ServerTemplate_ownerId_name_key" ON "ServerTemplate"("ownerId", "name");
