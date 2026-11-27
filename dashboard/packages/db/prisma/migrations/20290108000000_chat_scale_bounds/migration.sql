-- Chat at the size of a large community (docs/bugs, chat scale audit).
--
-- Additive: one column with a default, three indexes. Dropping them reverses it.

-- Who may use @everyone and @here in a space. False for every space that exists
-- and every one made after, so only the space's admins may, as Discord does.
ALTER TABLE "ChatSpace" ADD COLUMN IF NOT EXISTS "membersMayMentionEveryone" BOOLEAN NOT NULL DEFAULT false;

-- The member list, paged in join order with the id as the tie-breaker.
CREATE INDEX IF NOT EXISTS "ChatSpaceMember_spaceId_createdAt_id_idx" ON "ChatSpaceMember"("spaceId", "createdAt", "id");

-- Unread: each channel's read stops after 100 rows, walked on this index.
-- Partial, which the schema cannot declare - see the note on ChatMessage.
CREATE INDEX IF NOT EXISTS "ChatMessage_unread_channelId_createdAt_idx" ON "ChatMessage"("channelId", "createdAt") WHERE "deletedAt" IS NULL AND "parentId" IS NULL AND "kind" <> 'system';

-- The @ picker in a large room walks people in name order and stops at its
-- limit, with membership answered as an EXISTS per candidate.
CREATE INDEX IF NOT EXISTS "User_name_idx" ON "User"("name");
