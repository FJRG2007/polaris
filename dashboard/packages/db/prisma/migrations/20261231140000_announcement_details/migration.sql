-- Announcement details: a long-form text on each announcement and the updates
-- added to it afterwards. Additive: nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: DROP TABLE "AnnouncementUpdate";
-- ALTER TABLE "Announcement" DROP COLUMN "details".
ALTER TABLE "Announcement" ADD COLUMN IF NOT EXISTS "details" TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "AnnouncementUpdate" (
    "id" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnnouncementUpdate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AnnouncementUpdate_announcementId_createdAt_idx" ON "AnnouncementUpdate"("announcementId", "createdAt");

ALTER TABLE "AnnouncementUpdate" DROP CONSTRAINT IF EXISTS "AnnouncementUpdate_announcementId_fkey";
ALTER TABLE "AnnouncementUpdate" ADD CONSTRAINT "AnnouncementUpdate_announcementId_fkey"
    FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
