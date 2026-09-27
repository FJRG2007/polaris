-- Whether the messages an account receives in Chat are also shown to it inside
-- the game server it is playing on. Off for everybody until they turn it on, so
-- this migration changes nothing for anybody.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "messagesInGame" BOOLEAN NOT NULL DEFAULT false;
