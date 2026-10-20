-- Polar answer actions: a good or bad mark per answer and person, and a shared
-- snapshot that ends at the answer it was shared from. Existing shares keep
-- showing the whole chat.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "upToMessageId" TEXT;

CREATE TABLE IF NOT EXISTS "PolarAnswerFeedback" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarAnswerFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarAnswerFeedback_userId_messageId_key" ON "PolarAnswerFeedback"("userId", "messageId");
CREATE INDEX IF NOT EXISTS "PolarAnswerFeedback_updatedAt_idx" ON "PolarAnswerFeedback"("updatedAt" DESC);

ALTER TABLE "PolarAnswerFeedback" DROP CONSTRAINT IF EXISTS "PolarAnswerFeedback_userId_fkey";
ALTER TABLE "PolarAnswerFeedback" ADD CONSTRAINT "PolarAnswerFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolarAnswerFeedback" DROP CONSTRAINT IF EXISTS "PolarAnswerFeedback_messageId_fkey";
ALTER TABLE "PolarAnswerFeedback" ADD CONSTRAINT "PolarAnswerFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "PolarMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
