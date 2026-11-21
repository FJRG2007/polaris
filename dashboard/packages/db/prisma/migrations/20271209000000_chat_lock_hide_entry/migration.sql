-- Hide the "Locked chats" entry as well as the locked chats, so the list opens
-- only by typing the chat lock code into Chat search.
--
-- Additive only: one column whose default keeps every existing lock as it was.
-- Written to be safe to run twice.
ALTER TABLE "ChatLock" ADD COLUMN IF NOT EXISTS "hideEntry" BOOLEAN NOT NULL DEFAULT false;
