-- The Mail app: somebody else's mailbox, cached so it can be read at the speed
-- of a query instead of the speed of an IMAP round trip.
--
-- Every table here is a cache and can be dropped and rebuilt from the mail
-- server, with two exceptions that are the reason several of these columns
-- exist at all: what a person does HERE (labels, snoozes, pins, rules, trusted
-- senders, collected contacts) has no IMAP equivalent on most servers, and a
-- draft that has not been sent yet exists nowhere else. Those are keyed by the
-- message's own Message-Id as well as by its uid, so a mailbox resynced from
-- scratch does not lose them.
--
-- IF NOT EXISTS throughout, because a migration that failed partway has to be
-- finishable by running it again. A foreign key has no conditional add, so
-- each one is dropped by name first - before the add rather than merely
-- somewhere in the file, or the second run fails on the add exactly as it
-- would without a drop at all.

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "color" TEXT,
    "service" TEXT NOT NULL DEFAULT '',
    "auth" TEXT NOT NULL DEFAULT 'password',
    "connectionId" UUID,
    "username" TEXT NOT NULL DEFAULT '',
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "imapSecurity" TEXT NOT NULL DEFAULT 'tls',
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "smtpSecurity" TEXT NOT NULL DEFAULT 'tls',
    "encryptedSecret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'never',
    "stateDetail" TEXT NOT NULL DEFAULT '',
    "lastSyncAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "pollSeconds" INTEGER NOT NULL DEFAULT 300,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "unified" BOOLEAN NOT NULL DEFAULT true,
    "appendToSent" BOOLEAN NOT NULL DEFAULT true,
    "signature" TEXT NOT NULL DEFAULT '',
    "signatureAboveQuote" BOOLEAN NOT NULL DEFAULT true,
    "remoteContent" TEXT NOT NULL DEFAULT 'trusted',
    "nameTrackers" BOOLEAN NOT NULL DEFAULT true,
    "answerReceipts" BOOLEAN NOT NULL DEFAULT false,
    "cleanLinks" BOOLEAN NOT NULL DEFAULT true,
    "vacationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "vacationSubject" TEXT NOT NULL DEFAULT '',
    "vacationBody" TEXT NOT NULL DEFAULT '',
    "vacationStartsAt" TIMESTAMP(3),
    "vacationEndsAt" TIMESTAMP(3),
    "vacationRepeatDays" INTEGER NOT NULL DEFAULT 7,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailIdentity" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "replyTo" TEXT NOT NULL DEFAULT '',
    "signature" TEXT NOT NULL DEFAULT '',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailFolder" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL DEFAULT '/',
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'none',
    "subscribed" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "uidValidity" BIGINT,
    "uidNext" BIGINT,
    "highestModseq" BIGINT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),

    CONSTRAINT "MailFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailThread" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "subjectKey" TEXT,
    "subject" TEXT NOT NULL DEFAULT '',
    "participants" JSONB NOT NULL DEFAULT '[]',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snippet" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "MailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailMessage" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "folderId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "uid" BIGINT NOT NULL,
    "uidValidity" BIGINT,
    "messageId" TEXT NOT NULL DEFAULT '',
    "inReplyTo" TEXT NOT NULL DEFAULT '',
    "references" JSONB NOT NULL DEFAULT '[]',
    "listId" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "fromJson" JSONB NOT NULL DEFAULT '[]',
    "toJson" JSONB NOT NULL DEFAULT '[]',
    "ccJson" JSONB NOT NULL DEFAULT '[]',
    "bccJson" JSONB NOT NULL DEFAULT '[]',
    "replyToJson" JSONB NOT NULL DEFAULT '[]',
    "snippet" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "size" INTEGER NOT NULL DEFAULT 0,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "wantsReceipt" BOOLEAN NOT NULL DEFAULT false,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "headers" JSONB,
    "snoozedUntil" TIMESTAMP(3),
    "snoozeFolderId" UUID,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailAttachment" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "part" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" BIGINT NOT NULL DEFAULT 0,
    "contentId" TEXT NOT NULL DEFAULT '',
    "inline" BOOLEAN NOT NULL DEFAULT false,
    "connectionId" TEXT,
    "path" TEXT,
    "fetchedAt" TIMESTAMP(3),

    CONSTRAINT "MailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailLabel" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailMessageLabel" (
    "id" UUID NOT NULL,
    "labelId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "headerId" TEXT NOT NULL DEFAULT '',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailMessageLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailDraft" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "identityId" UUID,
    "toJson" JSONB NOT NULL DEFAULT '[]',
    "ccJson" JSONB NOT NULL DEFAULT '[]',
    "bccJson" JSONB NOT NULL DEFAULT '[]',
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "replyTo" TEXT NOT NULL DEFAULT '',
    "inReplyToId" UUID,
    "inReplyToHeader" TEXT NOT NULL DEFAULT '',
    "references" JSONB NOT NULL DEFAULT '[]',
    "forward" BOOLEAN NOT NULL DEFAULT false,
    "requestReceipt" BOOLEAN NOT NULL DEFAULT false,
    "sendAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'draft',
    "failure" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "serverUid" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailUpload" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "draftId" UUID,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" BIGINT NOT NULL DEFAULT 0,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "inline" BOOLEAN NOT NULL DEFAULT false,
    "contentId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailRule" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "match" TEXT NOT NULL DEFAULT 'all',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "stop" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailContact" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "receivedCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hidden" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MailContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailTrustedSender" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailTrustedSender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MailAutoReply" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "repliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailAutoReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailAccount_userId_position_idx" ON "MailAccount"("userId", "position");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailAccount_userId_address_key" ON "MailAccount"("userId", "address");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailIdentity_accountId_address_key" ON "MailIdentity"("accountId", "address");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailFolder_accountId_role_idx" ON "MailFolder"("accountId", "role");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailFolder_accountId_path_key" ON "MailFolder"("accountId", "path");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailThread_accountId_lastMessageAt_idx" ON "MailThread"("accountId", "lastMessageAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailThread_accountId_subjectKey_idx" ON "MailThread"("accountId", "subjectKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailMessage_accountId_sentAt_idx" ON "MailMessage"("accountId", "sentAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailMessage_threadId_sentAt_idx" ON "MailMessage"("threadId", "sentAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailMessage_folderId_sentAt_idx" ON "MailMessage"("folderId", "sentAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailMessage_accountId_messageId_idx" ON "MailMessage"("accountId", "messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailMessage_accountId_seen_idx" ON "MailMessage"("accountId", "seen");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailMessage_accountId_snoozedUntil_idx" ON "MailMessage"("accountId", "snoozedUntil");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailMessage_folderId_uid_key" ON "MailMessage"("folderId", "uid");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailAttachment_messageId_part_key" ON "MailAttachment"("messageId", "part");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailLabel_userId_name_key" ON "MailLabel"("userId", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailMessageLabel_messageId_idx" ON "MailMessageLabel"("messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailMessageLabel_labelId_headerId_idx" ON "MailMessageLabel"("labelId", "headerId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailMessageLabel_labelId_messageId_key" ON "MailMessageLabel"("labelId", "messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailDraft_accountId_updatedAt_idx" ON "MailDraft"("accountId", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailDraft_state_sendAt_idx" ON "MailDraft"("state", "sendAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailUpload_userId_createdAt_idx" ON "MailUpload"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailUpload_draftId_idx" ON "MailUpload"("draftId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailRule_accountId_position_idx" ON "MailRule"("accountId", "position");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailContact_accountId_lastSeenAt_idx" ON "MailContact"("accountId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailContact_accountId_address_key" ON "MailContact"("accountId", "address");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailTrustedSender_accountId_address_key" ON "MailTrustedSender"("accountId", "address");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MailAutoReply_repliedAt_idx" ON "MailAutoReply"("repliedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MailAutoReply_accountId_address_key" ON "MailAutoReply"("accountId", "address");

-- AddForeignKey
ALTER TABLE "MailAccount" DROP CONSTRAINT IF EXISTS "MailAccount_userId_fkey";
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAccount" DROP CONSTRAINT IF EXISTS "MailAccount_connectionId_fkey";
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "UserConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailIdentity" DROP CONSTRAINT IF EXISTS "MailIdentity_accountId_fkey";
ALTER TABLE "MailIdentity" ADD CONSTRAINT "MailIdentity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailFolder" DROP CONSTRAINT IF EXISTS "MailFolder_accountId_fkey";
ALTER TABLE "MailFolder" ADD CONSTRAINT "MailFolder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailThread" DROP CONSTRAINT IF EXISTS "MailThread_accountId_fkey";
ALTER TABLE "MailThread" ADD CONSTRAINT "MailThread_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" DROP CONSTRAINT IF EXISTS "MailMessage_accountId_fkey";
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" DROP CONSTRAINT IF EXISTS "MailMessage_folderId_fkey";
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "MailFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" DROP CONSTRAINT IF EXISTS "MailMessage_threadId_fkey";
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAttachment" DROP CONSTRAINT IF EXISTS "MailAttachment_messageId_fkey";
ALTER TABLE "MailAttachment" ADD CONSTRAINT "MailAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailLabel" DROP CONSTRAINT IF EXISTS "MailLabel_userId_fkey";
ALTER TABLE "MailLabel" ADD CONSTRAINT "MailLabel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessageLabel" DROP CONSTRAINT IF EXISTS "MailMessageLabel_labelId_fkey";
ALTER TABLE "MailMessageLabel" ADD CONSTRAINT "MailMessageLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "MailLabel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessageLabel" DROP CONSTRAINT IF EXISTS "MailMessageLabel_messageId_fkey";
ALTER TABLE "MailMessageLabel" ADD CONSTRAINT "MailMessageLabel_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDraft" DROP CONSTRAINT IF EXISTS "MailDraft_accountId_fkey";
ALTER TABLE "MailDraft" ADD CONSTRAINT "MailDraft_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDraft" DROP CONSTRAINT IF EXISTS "MailDraft_identityId_fkey";
ALTER TABLE "MailDraft" ADD CONSTRAINT "MailDraft_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "MailIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailUpload" DROP CONSTRAINT IF EXISTS "MailUpload_userId_fkey";
ALTER TABLE "MailUpload" ADD CONSTRAINT "MailUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailUpload" DROP CONSTRAINT IF EXISTS "MailUpload_draftId_fkey";
ALTER TABLE "MailUpload" ADD CONSTRAINT "MailUpload_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "MailDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailRule" DROP CONSTRAINT IF EXISTS "MailRule_accountId_fkey";
ALTER TABLE "MailRule" ADD CONSTRAINT "MailRule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailContact" DROP CONSTRAINT IF EXISTS "MailContact_accountId_fkey";
ALTER TABLE "MailContact" ADD CONSTRAINT "MailContact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailTrustedSender" DROP CONSTRAINT IF EXISTS "MailTrustedSender_accountId_fkey";
ALTER TABLE "MailTrustedSender" ADD CONSTRAINT "MailTrustedSender_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAutoReply" DROP CONSTRAINT IF EXISTS "MailAutoReply_accountId_fkey";
ALTER TABLE "MailAutoReply" ADD CONSTRAINT "MailAutoReply_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

