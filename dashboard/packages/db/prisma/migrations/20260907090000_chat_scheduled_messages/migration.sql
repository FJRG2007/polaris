-- A message written now and sent later.
--
-- It is not a message yet, and that is the whole design: nothing appears in the
-- conversation, nothing counts as unread, and taking it back leaves no trace.
-- The room hears about it when it is sent and not a second before.
--
-- The files are written when it is scheduled rather than when it goes, because
-- the bytes are on the machine that wrote them and a closed laptop takes them
-- with it. What is kept is exactly what an attachment row keeps, so sending is
-- the same call the live path makes.
CREATE TABLE "ChatScheduledMessage" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "parentId" UUID,
    "replyToId" UUID,
    "forwarded" BOOLEAN NOT NULL DEFAULT false,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failure" TEXT,
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "ChatScheduledMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatScheduledFile" (
    "id" UUID NOT NULL,
    "scheduledId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "contentType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "connectionId" UUID,
    "path" TEXT NOT NULL,
    "durationMs" INTEGER,
    "waveform" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatScheduledFile_pkey" PRIMARY KEY ("id")
);

-- What the sweep asks: due. And what the composer asks: mine, here, soonest first.
CREATE INDEX "ChatScheduledMessage_sendAt_idx" ON "ChatScheduledMessage"("sendAt");
CREATE INDEX "ChatScheduledMessage_channelId_authorId_sendAt_idx" ON "ChatScheduledMessage"("channelId", "authorId", "sendAt");
CREATE INDEX "ChatScheduledFile_scheduledId_idx" ON "ChatScheduledFile"("scheduledId");

ALTER TABLE "ChatScheduledMessage" ADD CONSTRAINT "ChatScheduledMessage_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatScheduledMessage" ADD CONSTRAINT "ChatScheduledMessage_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatScheduledFile" ADD CONSTRAINT "ChatScheduledFile_scheduledId_fkey"
    FOREIGN KEY ("scheduledId") REFERENCES "ChatScheduledMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
