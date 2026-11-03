-- Live translation in Chat: a reader's choice per conversation, and the record
-- on a message that was sent translated. Both nullable, so every existing row
-- reads as "not translated" with nothing to backfill.
ALTER TABLE "ChatChannelMember" ADD COLUMN "translation" JSONB;
ALTER TABLE "ChatMessage" ADD COLUMN "translation" JSONB;
