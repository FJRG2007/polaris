-- Migration of existing chats to sealed (docs/chat-e2ee-mls.md, "Migration of
-- existing chats"): the per-conversation state and the 30-day rollback copy of
-- the plain text a cut conversation held. Nothing reads or writes these while
-- the chat E2EE flag is off.
--
-- Additive, and a no-op when run again.
-- To reverse: DROP TABLE "ChatMigrationRollback", "ChatMigration";
CREATE TABLE IF NOT EXISTS "ChatMigration" (
    "channelId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "sealed" INTEGER NOT NULL DEFAULT 0,
    "signKey" BYTEA,
    "cutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatMigration_pkey" PRIMARY KEY ("channelId")
);
CREATE INDEX IF NOT EXISTS "ChatMigration_state_idx" ON "ChatMigration"("state");

CREATE TABLE IF NOT EXISTS "ChatMigrationRollback" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "messageId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "translation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMigrationRollback_pkey" PRIMARY KEY ("kind","id")
);
CREATE INDEX IF NOT EXISTS "ChatMigrationRollback_messageId_idx" ON "ChatMigrationRollback"("messageId");
CREATE INDEX IF NOT EXISTS "ChatMigrationRollback_channelId_idx" ON "ChatMigrationRollback"("channelId");
CREATE INDEX IF NOT EXISTS "ChatMigrationRollback_createdAt_idx" ON "ChatMigrationRollback"("createdAt");

DO $$ BEGIN
    ALTER TABLE "ChatMigration" ADD CONSTRAINT "ChatMigration_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ChatMigrationRollback" ADD CONSTRAINT "ChatMigrationRollback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
