-- One person's Drive settings: for now, whether moving something to the bin
-- asks first. Read through a schema, so a row is optional and an empty one is
-- the defaults.
--
-- Additive, and a no-op when run again.
-- To reverse: DROP TABLE "DrivePreference";
CREATE TABLE IF NOT EXISTS "DrivePreference" (
    "userId" UUID NOT NULL,
    "value" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrivePreference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "DrivePreference" DROP CONSTRAINT IF EXISTS "DrivePreference_userId_fkey";
ALTER TABLE "DrivePreference" ADD CONSTRAINT "DrivePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
