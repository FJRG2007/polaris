-- An organization's own chat.
--
-- Two columns and no data moves. `Organization.chatIsolated` is the choice, off
-- for every organization that already exists, because a chat that splits itself
-- in two without being asked is a history somebody has to go looking for.
-- `ChatChannel.orgId` is where a conversation was filed, and it stays null on
-- every row written so far - which is exactly what the shared chat is.
--
-- The unique key on `dmKey` needs no change: an organization's conversation
-- carries an `org:<id>:` prefix in the same column, so the same two people can
-- hold one conversation in each chat without either being able to collide with
-- the other.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "chatIsolated" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "orgId" UUID;

DO $$
BEGIN
    ALTER TABLE "ChatChannel"
        ADD CONSTRAINT "ChatChannel_orgId_fkey"
        FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ChatChannel_orgId_idx" ON "ChatChannel"("orgId");
