-- Temporary Polar chats: kept out of every list, search and memory, deleted
-- when their tab leaves them and swept a day after their last message.
-- Existing threads read as saved chats, which is what they are.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "temporary" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "PolarThread_temporary_updatedAt_idx" ON "PolarThread"("temporary", "updatedAt");
