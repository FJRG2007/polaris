-- CreateTable
CREATE TABLE "ChatSpaceAvatar" (
    "spaceId" UUID NOT NULL,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSpaceAvatar_pkey" PRIMARY KEY ("spaceId")
);

-- CreateTable
CREATE TABLE "ChatChannelAvatar" (
    "channelId" UUID NOT NULL,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatChannelAvatar_pkey" PRIMARY KEY ("channelId")
);

-- AddForeignKey
ALTER TABLE "ChatSpaceAvatar" ADD CONSTRAINT "ChatSpaceAvatar_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatChannelAvatar" ADD CONSTRAINT "ChatChannelAvatar_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

