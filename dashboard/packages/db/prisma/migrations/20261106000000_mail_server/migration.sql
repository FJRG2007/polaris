-- A mail server Polaris runs.
--
-- The engine is a Deploy service; these rows hold what only a mail server has:
-- its name, how far its setup got, the sealed credential Polaris manages it
-- with, its relay, the rules that turn incoming mail into notifications, and the
-- DMARC aggregate reports receivers send about its domains.
--
-- Every statement is safe to run twice (see README.md in this directory).
CREATE TABLE IF NOT EXISTS "MailServer" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "orgId" UUID,
    "placement" TEXT NOT NULL DEFAULT 'local',
    "applicationId" UUID,
    "hostname" TEXT NOT NULL,
    "primaryDomain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'setting-up',
    "step" TEXT NOT NULL DEFAULT '',
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "adminSecret" BYTEA,
    "adminSecretNonce" BYTEA,
    "adminSecretKeyId" TEXT,
    "hookSecret" BYTEA,
    "hookSecretNonce" BYTEA,
    "hookSecretKeyId" TEXT,
    "relay" TEXT NOT NULL DEFAULT '',
    "relaySecret" BYTEA,
    "relaySecretNonce" BYTEA,
    "relaySecretKeyId" TEXT,
    "reportsSecret" BYTEA,
    "reportsSecretNonce" BYTEA,
    "reportsSecretKeyId" TEXT,
    "reportsCheckedAt" TIMESTAMP(3),
    "reportsError" TEXT,
    "channelId" UUID,
    "lastPorts" TEXT NOT NULL DEFAULT '',
    "lastDns" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailServer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MailInboundRule" (
    "id" UUID NOT NULL,
    "serverId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "recipient" TEXT NOT NULL DEFAULT '',
    "sender" TEXT NOT NULL DEFAULT '',
    "includeSpam" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "windowStartedAt" TIMESTAMP(3),
    "windowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailInboundRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MailDmarcReport" (
    "id" UUID NOT NULL,
    "serverId" UUID NOT NULL,
    "orgName" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "beginAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "rows" JSONB NOT NULL DEFAULT '[]',
    "messages" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailDmarcReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MailServer_ownerId_idx" ON "MailServer"("ownerId");
CREATE INDEX IF NOT EXISTS "MailServer_orgId_idx" ON "MailServer"("orgId");
CREATE INDEX IF NOT EXISTS "MailServer_applicationId_idx" ON "MailServer"("applicationId");
CREATE INDEX IF NOT EXISTS "MailInboundRule_serverId_idx" ON "MailInboundRule"("serverId");
CREATE INDEX IF NOT EXISTS "MailDmarcReport_serverId_endAt_idx" ON "MailDmarcReport"("serverId", "endAt");
CREATE UNIQUE INDEX IF NOT EXISTS "MailDmarcReport_serverId_orgName_reportId_key" ON "MailDmarcReport"("serverId", "orgName", "reportId");

ALTER TABLE "MailInboundRule" DROP CONSTRAINT IF EXISTS "MailInboundRule_serverId_fkey";
ALTER TABLE "MailInboundRule" ADD CONSTRAINT "MailInboundRule_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "MailServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MailDmarcReport" DROP CONSTRAINT IF EXISTS "MailDmarcReport_serverId_fkey";
ALTER TABLE "MailDmarcReport" ADD CONSTRAINT "MailDmarcReport_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "MailServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
