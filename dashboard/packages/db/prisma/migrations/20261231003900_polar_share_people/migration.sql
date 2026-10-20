-- Polar chats sent to people: who a snapshot was sent to, with an optional
-- note, and whether the snapshot's public link answers at all. Existing shares
-- were links, so they keep answering.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarThreadShare" ADD COLUMN IF NOT EXISTS "linkEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "PolarShareRecipient" (
    "id" UUID NOT NULL,
    "shareId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarShareRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarShareRecipient_shareId_userId_key" ON "PolarShareRecipient"("shareId", "userId");
CREATE INDEX IF NOT EXISTS "PolarShareRecipient_userId_createdAt_idx" ON "PolarShareRecipient"("userId", "createdAt" DESC);

ALTER TABLE "PolarShareRecipient" DROP CONSTRAINT IF EXISTS "PolarShareRecipient_shareId_fkey";
ALTER TABLE "PolarShareRecipient" ADD CONSTRAINT "PolarShareRecipient_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "PolarThreadShare"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolarShareRecipient" DROP CONSTRAINT IF EXISTS "PolarShareRecipient_userId_fkey";
ALTER TABLE "PolarShareRecipient" ADD CONSTRAINT "PolarShareRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
