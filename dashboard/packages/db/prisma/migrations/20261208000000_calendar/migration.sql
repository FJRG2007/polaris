-- Polaris Calendar (apps/calendar, docs/calendar-plan.md): calendars, their
-- objects, sharing, reminders, invitations, booking pages and proposals, and the
-- `calendar.use` permission on the seeded roles that hold mail.
--
-- Every statement is written so that running it a second time is a no-op.
-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarSource" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "connectionId" UUID,
    "url" TEXT NOT NULL DEFAULT '',
    "username" TEXT NOT NULL DEFAULT '',
    "encryptedSecret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "refreshMinutes" INTEGER NOT NULL DEFAULT 15,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "lastError" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Calendar" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "sourceId" UUID,
    "kind" TEXT NOT NULL DEFAULT 'local',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "timezone" TEXT NOT NULL DEFAULT '',
    "components" TEXT NOT NULL DEFAULT 'VEVENT',
    "remoteId" TEXT NOT NULL DEFAULT '',
    "syncToken" TEXT NOT NULL DEFAULT '',
    "ctag" TEXT NOT NULL DEFAULT '',
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "transparent" BOOLEAN NOT NULL DEFAULT false,
    "alarmsMuted" BOOLEAN NOT NULL DEFAULT false,
    "defaultAlarms" TEXT NOT NULL DEFAULT '',
    "resource" TEXT NOT NULL DEFAULT '',
    "publicToken" TEXT,
    "publicMode" TEXT NOT NULL DEFAULT '',
    "trashedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarDisplay" (
    "id" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT,

    CONSTRAINT "CalendarDisplay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarShare" (
    "id" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "userId" UUID,
    "teamId" UUID,
    "access" TEXT NOT NULL DEFAULT 'read',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarObject" (
    "id" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "uid" TEXT NOT NULL,
    "component" TEXT NOT NULL DEFAULT 'VEVENT',
    "ics" TEXT NOT NULL,
    "href" TEXT NOT NULL DEFAULT '',
    "etag" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT '',
    "pendingPush" TEXT NOT NULL DEFAULT '',
    "conflictIcs" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarReminder" (
    "id" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "occurrence" TIMESTAMP(3) NOT NULL,
    "alarmKey" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'DISPLAY',

    CONSTRAINT "CalendarReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarInvitation" (
    "id" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "userId" UUID,
    "token" TEXT NOT NULL,
    "partstat" TEXT NOT NULL DEFAULT 'NEEDS-ACTION',
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarBookingPage" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "visibility" TEXT NOT NULL DEFAULT 'link',
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "slotMinutes" INTEGER NOT NULL DEFAULT 30,
    "bufferBefore" INTEGER NOT NULL DEFAULT 0,
    "bufferAfter" INTEGER NOT NULL DEFAULT 0,
    "noticeMinutes" INTEGER NOT NULL DEFAULT 240,
    "maxPerDay" INTEGER,
    "horizonDays" INTEGER NOT NULL DEFAULT 60,
    "timezone" TEXT NOT NULL,
    "availability" TEXT NOT NULL,
    "conflictIds" TEXT NOT NULL DEFAULT '[]',
    "questions" TEXT NOT NULL DEFAULT '[]',
    "meetingLink" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarBookingPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarBooking" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "objectId" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "answers" TEXT NOT NULL DEFAULT '{}',
    "timezone" TEXT NOT NULL DEFAULT '',
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmToken" TEXT NOT NULL,
    "manageToken" TEXT NOT NULL,
    "requester" TEXT NOT NULL DEFAULT '',
    "locale" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarProposal" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "calendarId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "timezone" TEXT NOT NULL DEFAULT '',
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'open',
    "objectId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarProposalDate" (
    "id" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarProposalDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarProposalParticipant" (
    "id" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "userId" UUID,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "token" TEXT NOT NULL,
    "votes" TEXT NOT NULL DEFAULT '{}',
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarProposalParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarPreference" (
    "userId" UUID NOT NULL,
    "value" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarSource_userId_idx" ON "CalendarSource"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarSource_nextSyncAt_idx" ON "CalendarSource"("nextSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Calendar_publicToken_key" ON "Calendar"("publicToken");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Calendar_ownerId_idx" ON "Calendar"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Calendar_sourceId_idx" ON "Calendar"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Calendar_sourceId_remoteId_key" ON "Calendar"("sourceId", "remoteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Calendar_kind_idx" ON "Calendar"("kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarDisplay_userId_idx" ON "CalendarDisplay"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarDisplay_calendarId_userId_key" ON "CalendarDisplay"("calendarId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarShare_userId_idx" ON "CalendarShare"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarShare_teamId_idx" ON "CalendarShare"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarShare_calendarId_userId_key" ON "CalendarShare"("calendarId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarShare_calendarId_teamId_key" ON "CalendarShare"("calendarId", "teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarObject_calendarId_startsAt_idx" ON "CalendarObject"("calendarId", "startsAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarObject_calendarId_endsAt_idx" ON "CalendarObject"("calendarId", "endsAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarObject_deletedAt_idx" ON "CalendarObject"("deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarObject_pendingPush_idx" ON "CalendarObject"("pendingPush");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarObject_calendarId_uid_key" ON "CalendarObject"("calendarId", "uid");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarReminder_fireAt_idx" ON "CalendarReminder"("fireAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarReminder_objectId_userId_alarmKey_occurrence_key" ON "CalendarReminder"("objectId", "userId", "alarmKey", "occurrence");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarInvitation_token_key" ON "CalendarInvitation"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarInvitation_userId_idx" ON "CalendarInvitation"("userId");

-- CreateTable
CREATE TABLE IF NOT EXISTS "CalendarLease" (
    "key" TEXT NOT NULL,
    "until" BIGINT NOT NULL,

    CONSTRAINT "CalendarLease_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarInvitation_objectId_email_key" ON "CalendarInvitation"("objectId", "email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarBookingPage_slug_key" ON "CalendarBookingPage"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarBookingPage_ownerId_idx" ON "CalendarBookingPage"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarBookingPage_calendarId_idx" ON "CalendarBookingPage"("calendarId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarBooking_confirmToken_key" ON "CalendarBooking"("confirmToken");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarBooking_manageToken_key" ON "CalendarBooking"("manageToken");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarBooking_pageId_start_idx" ON "CalendarBooking"("pageId", "start");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarBooking_status_createdAt_idx" ON "CalendarBooking"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarBooking_objectId_idx" ON "CalendarBooking"("objectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarProposal_ownerId_idx" ON "CalendarProposal"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarProposal_calendarId_idx" ON "CalendarProposal"("calendarId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarProposal_objectId_idx" ON "CalendarProposal"("objectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CalendarProposalDate_proposalId_idx" ON "CalendarProposalDate"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarProposalParticipant_token_key" ON "CalendarProposalParticipant"("token");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CalendarProposalParticipant_proposalId_email_key" ON "CalendarProposalParticipant"("proposalId", "email");

-- AddForeignKey
ALTER TABLE "CalendarSource" DROP CONSTRAINT IF EXISTS "CalendarSource_userId_fkey";
ALTER TABLE "CalendarSource" ADD CONSTRAINT "CalendarSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarSource" DROP CONSTRAINT IF EXISTS "CalendarSource_connectionId_fkey";
ALTER TABLE "CalendarSource" ADD CONSTRAINT "CalendarSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "UserConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Calendar" DROP CONSTRAINT IF EXISTS "Calendar_ownerId_fkey";
ALTER TABLE "Calendar" ADD CONSTRAINT "Calendar_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Calendar" DROP CONSTRAINT IF EXISTS "Calendar_sourceId_fkey";
ALTER TABLE "Calendar" ADD CONSTRAINT "Calendar_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "CalendarSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarDisplay" DROP CONSTRAINT IF EXISTS "CalendarDisplay_calendarId_fkey";
ALTER TABLE "CalendarDisplay" ADD CONSTRAINT "CalendarDisplay_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarDisplay" DROP CONSTRAINT IF EXISTS "CalendarDisplay_userId_fkey";
ALTER TABLE "CalendarDisplay" ADD CONSTRAINT "CalendarDisplay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarShare" DROP CONSTRAINT IF EXISTS "CalendarShare_calendarId_fkey";
ALTER TABLE "CalendarShare" ADD CONSTRAINT "CalendarShare_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarShare" DROP CONSTRAINT IF EXISTS "CalendarShare_userId_fkey";
ALTER TABLE "CalendarShare" ADD CONSTRAINT "CalendarShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarShare" DROP CONSTRAINT IF EXISTS "CalendarShare_teamId_fkey";
ALTER TABLE "CalendarShare" ADD CONSTRAINT "CalendarShare_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarObject" DROP CONSTRAINT IF EXISTS "CalendarObject_calendarId_fkey";
ALTER TABLE "CalendarObject" ADD CONSTRAINT "CalendarObject_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarReminder" DROP CONSTRAINT IF EXISTS "CalendarReminder_objectId_fkey";
ALTER TABLE "CalendarReminder" ADD CONSTRAINT "CalendarReminder_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "CalendarObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarReminder" DROP CONSTRAINT IF EXISTS "CalendarReminder_userId_fkey";
ALTER TABLE "CalendarReminder" ADD CONSTRAINT "CalendarReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarInvitation" DROP CONSTRAINT IF EXISTS "CalendarInvitation_objectId_fkey";
ALTER TABLE "CalendarInvitation" ADD CONSTRAINT "CalendarInvitation_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "CalendarObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBookingPage" DROP CONSTRAINT IF EXISTS "CalendarBookingPage_ownerId_fkey";
ALTER TABLE "CalendarBookingPage" ADD CONSTRAINT "CalendarBookingPage_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBookingPage" DROP CONSTRAINT IF EXISTS "CalendarBookingPage_calendarId_fkey";
ALTER TABLE "CalendarBookingPage" ADD CONSTRAINT "CalendarBookingPage_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBooking" DROP CONSTRAINT IF EXISTS "CalendarBooking_pageId_fkey";
ALTER TABLE "CalendarBooking" ADD CONSTRAINT "CalendarBooking_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "CalendarBookingPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBooking" DROP CONSTRAINT IF EXISTS "CalendarBooking_objectId_fkey";
ALTER TABLE "CalendarBooking" ADD CONSTRAINT "CalendarBooking_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "CalendarObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarProposal" DROP CONSTRAINT IF EXISTS "CalendarProposal_ownerId_fkey";
ALTER TABLE "CalendarProposal" ADD CONSTRAINT "CalendarProposal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarProposal" DROP CONSTRAINT IF EXISTS "CalendarProposal_calendarId_fkey";
ALTER TABLE "CalendarProposal" ADD CONSTRAINT "CalendarProposal_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarProposal" DROP CONSTRAINT IF EXISTS "CalendarProposal_objectId_fkey";
ALTER TABLE "CalendarProposal" ADD CONSTRAINT "CalendarProposal_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "CalendarObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarProposalDate" DROP CONSTRAINT IF EXISTS "CalendarProposalDate_proposalId_fkey";
ALTER TABLE "CalendarProposalDate" ADD CONSTRAINT "CalendarProposalDate_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "CalendarProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarProposalParticipant" DROP CONSTRAINT IF EXISTS "CalendarProposalParticipant_proposalId_fkey";
ALTER TABLE "CalendarProposalParticipant" ADD CONSTRAINT "CalendarProposalParticipant_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "CalendarProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarPreference" DROP CONSTRAINT IF EXISTS "CalendarPreference_userId_fkey";
ALTER TABLE "CalendarPreference" ADD CONSTRAINT "CalendarPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Give the seeded member and viewer roles `calendar.use`, the way they hold
-- `mail.use`: a calendar is the account's own. Only where it is missing, so a
-- role an operator narrowed on purpose keeps everything else it says. Seeding
-- cannot do this: it never rewrites a role that already exists.
UPDATE "Role"
SET "permissions" = (("permissions"::jsonb) || '["calendar.use"]'::jsonb)::text
WHERE "isSystem" = true
  AND "name" IN ('member', 'viewer')
  AND jsonb_typeof("permissions"::jsonb) = 'array'
  AND NOT (("permissions"::jsonb) @> '["calendar.use"]'::jsonb);
