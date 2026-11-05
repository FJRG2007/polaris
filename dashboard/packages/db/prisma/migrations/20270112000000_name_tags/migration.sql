-- Name tags: an organization's tag, and the one tag each account wears.
-- Additive only: new nullable or defaulted columns and a new table.

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "tagEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "tagText" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "tagEmblem" TEXT NOT NULL DEFAULT 'spark';
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "tagColor" TEXT NOT NULL DEFAULT 'blue';

-- CreateTable
CREATE TABLE IF NOT EXISTS "NameTagChoice" (
    "userId" UUID NOT NULL,
    "orgId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NameTagChoice_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NameTagChoice_orgId_idx" ON "NameTagChoice"("orgId");

-- AddForeignKey
ALTER TABLE "NameTagChoice" DROP CONSTRAINT IF EXISTS "NameTagChoice_userId_fkey";
ALTER TABLE "NameTagChoice" ADD CONSTRAINT "NameTagChoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NameTagChoice" DROP CONSTRAINT IF EXISTS "NameTagChoice_orgId_fkey";
ALTER TABLE "NameTagChoice" ADD CONSTRAINT "NameTagChoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
