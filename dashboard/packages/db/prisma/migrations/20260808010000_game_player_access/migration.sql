-- Who may connect to a game server, and from where.
CREATE TABLE "GamePlayerAccess" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GamePlayerAccess_pkey" PRIMARY KEY ("id")
);

-- One rule per player per server: adding a name that is already listed edits it.
CREATE UNIQUE INDEX "GamePlayerAccess_installedAppId_username_key"
    ON "GamePlayerAccess"("installedAppId", "username");

CREATE INDEX "GamePlayerAccess_installedAppId_idx" ON "GamePlayerAccess"("installedAppId");
