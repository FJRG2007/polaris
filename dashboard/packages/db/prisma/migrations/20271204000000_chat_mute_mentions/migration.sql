-- Whether a conversation's mute holds back mentions as well.
--
-- Additive only: one column with a default of false, so every existing mute
-- lets a mention of its reader through, the way Discord, WhatsApp and Telegram
-- do. Written to be safe to run twice.
ALTER TABLE "ChatChannelMember" ADD COLUMN IF NOT EXISTS "muteMentions" BOOLEAN NOT NULL DEFAULT false;
