-- One person's Chat settings: for now, whether a caption is drawn above or
-- below the pictures it came with. Read through a schema, so a row is optional
-- and an empty one is the defaults.
--
-- Additive, and a no-op when run again.
-- To reverse: DROP TABLE "ChatPreference";
CREATE TABLE IF NOT EXISTS "ChatPreference" (
    "userId" UUID NOT NULL,
    "value" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatPreference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "ChatPreference" DROP CONSTRAINT IF EXISTS "ChatPreference_userId_fkey";
ALTER TABLE "ChatPreference" ADD CONSTRAINT "ChatPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
