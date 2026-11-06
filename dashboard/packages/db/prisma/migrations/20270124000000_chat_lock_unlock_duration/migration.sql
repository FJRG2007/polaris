-- How long locked chats stay open after the code, and how many digits it has.
-- Additive: existing locks keep "until the browser closes" and no known length.
ALTER TABLE "ChatLock" ADD COLUMN IF NOT EXISTS "unlockMinutes" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "ChatLock" ADD COLUMN IF NOT EXISTS "codeLength" INTEGER;
