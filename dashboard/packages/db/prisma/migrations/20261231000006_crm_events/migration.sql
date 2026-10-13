-- The CRM's activity log: one row per thing that happened to a record, read
-- newest first on its page. Additive; to reverse, drop CrmEvent.

CREATE TABLE IF NOT EXISTS "CrmEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "object" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actorId" UUID,
    "changes" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmEvent_recordId_id_idx" ON "CrmEvent"("recordId", "id");

-- AddForeignKey
ALTER TABLE "CrmEvent" DROP CONSTRAINT IF EXISTS "CrmEvent_orgId_fkey";
ALTER TABLE "CrmEvent" ADD CONSTRAINT "CrmEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEvent" DROP CONSTRAINT IF EXISTS "CrmEvent_userId_fkey";
ALTER TABLE "CrmEvent" ADD CONSTRAINT "CrmEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
