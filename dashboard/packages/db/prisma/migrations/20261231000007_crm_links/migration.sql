-- What a CRM record is linked to elsewhere in Polaris: a note, a task, a Drive
-- file. The target lives in its own app and is read through it, so a target
-- that is gone or not the reader's to open is simply not shown. Additive; to
-- reverse, drop CrmLink.

CREATE TABLE IF NOT EXISTS "CrmLink" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "object" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CrmLink_recordId_kind_targetId_key" ON "CrmLink"("recordId", "kind", "targetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrmLink_recordId_kind_id_idx" ON "CrmLink"("recordId", "kind", "id");

-- AddForeignKey
ALTER TABLE "CrmLink" DROP CONSTRAINT IF EXISTS "CrmLink_orgId_fkey";
ALTER TABLE "CrmLink" ADD CONSTRAINT "CrmLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmLink" DROP CONSTRAINT IF EXISTS "CrmLink_userId_fkey";
ALTER TABLE "CrmLink" ADD CONSTRAINT "CrmLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
