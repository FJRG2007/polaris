-- Messages in a game move to a choice that can say "direct only", now that the
-- default (null) is every conversation. An account that chose everything or
-- nothing keeps its choice; one that never chose - stored as null before and
-- now - gets the new default. The old column stays, no longer read or written.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "inGameMessages" TEXT;
UPDATE "User" SET "inGameMessages" = CASE WHEN "messagesInGame" THEN 'all' ELSE 'off' END
WHERE "messagesInGame" IS NOT NULL AND "inGameMessages" IS NULL;
