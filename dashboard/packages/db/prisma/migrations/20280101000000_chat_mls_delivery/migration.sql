-- Chat over MLS, behind the internal chat E2EE flag (docs/chat-e2ee-mls.md):
-- devices, their key packages, one group per conversation, the delivery
-- service's ordered log and the history-key envelopes. Nothing reads or
-- writes these while the flag is off.
--
-- Additive, and a no-op when run again.
-- To reverse: DROP TABLE "ChatHistoryKey", "MlsGroupEvent", "MlsGroup", "MlsKeyPackage", "MlsDevice";
CREATE TABLE IF NOT EXISTS "MlsDevice" (
    "userId" UUID NOT NULL,
    "device" TEXT NOT NULL,
    "signatureKey" BYTEA NOT NULL,
    "e2eeVersion" INTEGER NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlsDevice_pkey" PRIMARY KEY ("userId","device")
);

CREATE TABLE IF NOT EXISTS "MlsKeyPackage" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "device" TEXT NOT NULL,
    "ciphersuite" INTEGER NOT NULL,
    "keyPackage" BYTEA NOT NULL,
    "lastResort" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlsKeyPackage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MlsKeyPackage_userId_ciphersuite_lastResort_createdAt_idx" ON "MlsKeyPackage"("userId", "ciphersuite", "lastResort", "createdAt");
CREATE INDEX IF NOT EXISTS "MlsKeyPackage_userId_device_idx" ON "MlsKeyPackage"("userId", "device");

CREATE TABLE IF NOT EXISTS "MlsGroup" (
    "channelId" UUID NOT NULL,
    "groupId" BYTEA NOT NULL,
    "ciphersuite" INTEGER NOT NULL,
    "epoch" BIGINT NOT NULL DEFAULT 0,
    "groupInfo" BYTEA,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlsGroup_pkey" PRIMARY KEY ("channelId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MlsGroup_groupId_key" ON "MlsGroup"("groupId");

CREATE TABLE IF NOT EXISTS "MlsGroupEvent" (
    "seq" BIGSERIAL NOT NULL,
    "channelId" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "recipient" TEXT,
    "payload" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlsGroupEvent_pkey" PRIMARY KEY ("seq")
);
CREATE INDEX IF NOT EXISTS "MlsGroupEvent_channelId_seq_idx" ON "MlsGroupEvent"("channelId", "seq");
CREATE INDEX IF NOT EXISTS "MlsGroupEvent_recipient_seq_idx" ON "MlsGroupEvent"("recipient", "seq");

CREATE TABLE IF NOT EXISTS "ChatHistoryKey" (
    "channelId" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "recipient" TEXT NOT NULL,
    "envelope" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatHistoryKey_pkey" PRIMARY KEY ("channelId","epoch","recipient")
);
