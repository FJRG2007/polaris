-- Polar, the dashboard's assistant: one person's conversations and their messages.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "PolarThread" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "choice" JSONB,
    "queue" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PolarMessage" (
    "id" TEXT NOT NULL,
    "threadId" UUID NOT NULL,
    "parentId" TEXT,
    "role" TEXT NOT NULL,
    "parts" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarThread_userId_updatedAt_idx" ON "PolarThread"("userId", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS "PolarMessage_threadId_createdAt_idx" ON "PolarMessage"("threadId", "createdAt");

ALTER TABLE "PolarThread" DROP CONSTRAINT IF EXISTS "PolarThread_userId_fkey";
ALTER TABLE "PolarThread" ADD CONSTRAINT "PolarThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolarMessage" DROP CONSTRAINT IF EXISTS "PolarMessage_threadId_fkey";
ALTER TABLE "PolarMessage" ADD CONSTRAINT "PolarMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "PolarThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
