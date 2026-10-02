-- Private names for deployed services: `<name>.polaris.internal` and the bare
-- `<name>` inside a project's environment, the extra names a service answers to,
-- and links that let one service call another project's by name.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "privateNetwork" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "ManagedDatabase" ADD COLUMN IF NOT EXISTS "privateNetwork" TEXT NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE IF NOT EXISTS "PrivateLink" (
    "id" UUID NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivateLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PrivateLink_targetKind_targetId_sourceId_key" ON "PrivateLink"("targetKind", "targetId", "sourceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PrivateLink_sourceId_idx" ON "PrivateLink"("sourceId");
