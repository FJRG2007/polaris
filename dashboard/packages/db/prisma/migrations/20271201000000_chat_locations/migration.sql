-- Location messages in Chat. Additive only, and safe to run twice: the
-- entrypoint retries migrations and an update can stop one part-way.
-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatLocation" (
    "messageId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "placeName" TEXT,
    "address" TEXT,
    "liveUntil" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatLocation_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatLocation_liveUntil_idx" ON "ChatLocation"("liveUntil");

-- AddForeignKey
ALTER TABLE "ChatLocation" DROP CONSTRAINT IF EXISTS "ChatLocation_messageId_fkey";
ALTER TABLE "ChatLocation" ADD CONSTRAINT "ChatLocation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
