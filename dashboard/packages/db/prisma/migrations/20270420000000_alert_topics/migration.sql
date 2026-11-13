-- Alert topics: addresses other systems post alerts to, and what each received.
CREATE TABLE IF NOT EXISTS "AlertTopic" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "orgId" UUID,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenTail" TEXT NOT NULL,
    "defaultPriority" INTEGER NOT NULL DEFAULT 3,
    "pushFrom" INTEGER NOT NULL DEFAULT 3,
    "recipientUserIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "recipientTeamIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AlertTopic_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AlertTopic_ownerId_idx" ON "AlertTopic"("ownerId");
CREATE INDEX IF NOT EXISTS "AlertTopic_orgId_idx" ON "AlertTopic"("orgId");

CREATE TABLE IF NOT EXISTS "AlertDelivery" (
    "id" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "priority" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "markdown" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "click" TEXT,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "dedupKey" TEXT,
    "source" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AlertDelivery_topicId_createdAt_idx" ON "AlertDelivery"("topicId", "createdAt");

ALTER TABLE "AlertTopic" DROP CONSTRAINT IF EXISTS "AlertTopic_ownerId_fkey";
ALTER TABLE "AlertTopic" ADD CONSTRAINT "AlertTopic_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertTopic" DROP CONSTRAINT IF EXISTS "AlertTopic_orgId_fkey";
ALTER TABLE "AlertTopic" ADD CONSTRAINT "AlertTopic_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertDelivery" DROP CONSTRAINT IF EXISTS "AlertDelivery_topicId_fkey";
ALTER TABLE "AlertDelivery" ADD CONSTRAINT "AlertDelivery_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "AlertTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
