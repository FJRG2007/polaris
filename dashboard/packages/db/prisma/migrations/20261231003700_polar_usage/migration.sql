-- What each Polar answer spent: tokens per answer, and the cost when the model
-- catalogue prices the model. A new table only; nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "PolarUsage" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "threadId" UUID,
    "messageId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarUsage_userId_createdAt_idx" ON "PolarUsage"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "PolarUsage_payer_createdAt_idx" ON "PolarUsage"("payer", "createdAt");

ALTER TABLE "PolarUsage" DROP CONSTRAINT IF EXISTS "PolarUsage_userId_fkey";
ALTER TABLE "PolarUsage" ADD CONSTRAINT "PolarUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
