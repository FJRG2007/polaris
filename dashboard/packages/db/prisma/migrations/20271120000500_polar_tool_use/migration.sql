-- Tool calls per answer, summed on Polar's usage screen
-- (apps/web/src/lib/polar/usage.ts). Rerunnable.
CREATE TABLE IF NOT EXISTS "PolarToolUse" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "threadId" UUID,
    "tool" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolarToolUse_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PolarToolUse_userId_createdAt_idx" ON "PolarToolUse"("userId", "createdAt");

ALTER TABLE "PolarToolUse" DROP CONSTRAINT IF EXISTS "PolarToolUse_userId_fkey";
ALTER TABLE "PolarToolUse" ADD CONSTRAINT "PolarToolUse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
