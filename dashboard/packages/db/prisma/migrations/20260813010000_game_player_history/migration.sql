-- Game servers keep a history of who played and when. Both tables are written by
-- the game-players sweep, which asks each server who is on once a minute.
--
-- GamePlayerSession is the history and also the sweep's memory: the rows with no
-- leftAt are who was on when it last looked, so comparing a fresh roster against
-- them is what produces an arrival or a departure. GameSample records that anybody
-- looked at all, which is what stops an empty night and a night with no sweep from
-- drawing the same flat line.

CREATE TABLE "GamePlayerSession" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "GamePlayerSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GamePlayerSession_installedAppId_joinedAt_idx" ON "GamePlayerSession"("installedAppId", "joinedAt");

-- The sweep's hottest read: the open sessions for one server.
CREATE INDEX "GamePlayerSession_installedAppId_leftAt_idx" ON "GamePlayerSession"("installedAppId", "leftAt");

CREATE INDEX "GamePlayerSession_installedAppId_name_idx" ON "GamePlayerSession"("installedAppId", "name");

CREATE TABLE "GameSample" (
    "installedAppId" UUID NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "playersOnline" INTEGER NOT NULL,

    CONSTRAINT "GameSample_pkey" PRIMARY KEY ("installedAppId","ts")
);

CREATE INDEX "GameSample_ts_idx" ON "GameSample"("ts");
