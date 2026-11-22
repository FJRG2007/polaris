-- Forum channels: posts with a title and tags, guidelines and required tags.
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "forumGuidelines" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "forumRequireTag" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "ChatForumTag" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatForumTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ChatForumPost" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "rootMessageId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "tagIds" UUID[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatForumPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChatForumTag_channelId_name_key" ON "ChatForumTag"("channelId", "name");

CREATE UNIQUE INDEX IF NOT EXISTS "ChatForumPost_rootMessageId_key" ON "ChatForumPost"("rootMessageId");

CREATE INDEX IF NOT EXISTS "ChatForumPost_channelId_lastActivityAt_idx" ON "ChatForumPost"("channelId", "lastActivityAt");

CREATE INDEX IF NOT EXISTS "ChatForumPost_channelId_createdAt_idx" ON "ChatForumPost"("channelId", "createdAt");

ALTER TABLE "ChatForumTag" DROP CONSTRAINT IF EXISTS "ChatForumTag_channelId_fkey";
ALTER TABLE "ChatForumTag" ADD CONSTRAINT "ChatForumTag_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatForumPost" DROP CONSTRAINT IF EXISTS "ChatForumPost_channelId_fkey";
ALTER TABLE "ChatForumPost" ADD CONSTRAINT "ChatForumPost_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatForumPost" DROP CONSTRAINT IF EXISTS "ChatForumPost_rootMessageId_fkey";
ALTER TABLE "ChatForumPost" ADD CONSTRAINT "ChatForumPost_rootMessageId_fkey" FOREIGN KEY ("rootMessageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
