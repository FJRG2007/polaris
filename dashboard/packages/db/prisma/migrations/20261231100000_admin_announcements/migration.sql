-- Administrator announcements and maintenance banners: two new tables and
-- their indexes. Additive: nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: DROP TABLE "AnnouncementDismissal"; DROP TABLE "Announcement";
-- DROP INDEX "Notification_conditionKey_idx".
CREATE TABLE IF NOT EXISTS "Announcement" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'announcement',
    "template" TEXT NOT NULL DEFAULT 'generic',
    "localized" BOOLEAN NOT NULL DEFAULT false,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "linkUrl" TEXT,
    "linkLabel" TEXT,
    "vars" TEXT,
    "audience" TEXT NOT NULL,
    "sendNotice" BOOLEAN NOT NULL DEFAULT true,
    "showBanner" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "leadMinutes" INTEGER,
    "notifySteps" BOOLEAN NOT NULL DEFAULT false,
    "noticedPhase" TEXT,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retractedAt" TIMESTAMP(3),
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Announcement_showBanner_retractedAt_startsAt_endsAt_idx" ON "Announcement"("showBanner", "retractedAt", "startsAt", "endsAt");
CREATE INDEX IF NOT EXISTS "Announcement_retractedAt_startsAt_idx" ON "Announcement"("retractedAt", "startsAt");
CREATE INDEX IF NOT EXISTS "Announcement_createdAt_idx" ON "Announcement"("createdAt");

CREATE TABLE IF NOT EXISTS "AnnouncementDismissal" (
    "announcementId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnnouncementDismissal_pkey" PRIMARY KEY ("announcementId", "userId")
);

CREATE INDEX IF NOT EXISTS "AnnouncementDismissal_userId_idx" ON "AnnouncementDismissal"("userId");

ALTER TABLE "AnnouncementDismissal" DROP CONSTRAINT IF EXISTS "AnnouncementDismissal_announcementId_fkey";
ALTER TABLE "AnnouncementDismissal" ADD CONSTRAINT "AnnouncementDismissal_announcementId_fkey"
    FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnnouncementDismissal" DROP CONSTRAINT IF EXISTS "AnnouncementDismissal_userId_fkey";
ALTER TABLE "AnnouncementDismissal" ADD CONSTRAINT "AnnouncementDismissal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The history counts how many readers opened an announcement's notice by its key.
CREATE INDEX IF NOT EXISTS "Notification_conditionKey_idx" ON "Notification"("conditionKey");
