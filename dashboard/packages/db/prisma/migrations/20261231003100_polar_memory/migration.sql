-- Polar's memory: short facts about a person it reads in every chat, and the
-- per-person switch that turns reading and writing them off. No row in
-- PolarPreference reads as memory on, so existing people need nothing written.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "PolarMemory" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "threadId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarMemory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarMemory_userId_updatedAt_idx" ON "PolarMemory"("userId", "updatedAt" DESC);

ALTER TABLE "PolarMemory" DROP CONSTRAINT IF EXISTS "PolarMemory_userId_fkey";
ALTER TABLE "PolarMemory" ADD CONSTRAINT "PolarMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PolarPreference" (
    "userId" UUID NOT NULL,
    "memory" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarPreference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "PolarPreference" DROP CONSTRAINT IF EXISTS "PolarPreference_userId_fkey";
ALTER TABLE "PolarPreference" ADD CONSTRAINT "PolarPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
