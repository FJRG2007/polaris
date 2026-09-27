-- Messages in a game become a three-way choice: null (the new default) shows
-- direct messages and small groups, true shows everything, false nothing.
-- Nobody could tell "off" from "never touched" before, and the switch shipped
-- the same day, so every account that has not turned it on gets the default.
ALTER TABLE "User" ALTER COLUMN "messagesInGame" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "messagesInGame" DROP DEFAULT;
UPDATE "User" SET "messagesInGame" = NULL WHERE "messagesInGame" = false;
