-- The access log: one row per use of a grant, done or refused, kept 90 days.
-- Additive only. Every statement is written so that running it a second time
-- is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "GrantUse" (
    "id" UUID NOT NULL,
    "grantId" UUID,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "userId" UUID,
    "linkNote" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrantUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GrantUse_subjectType_subjectId_at_idx" ON "GrantUse"("subjectType", "subjectId", "at");
CREATE INDEX IF NOT EXISTS "GrantUse_targetId_at_idx" ON "GrantUse"("targetId", "at");
CREATE INDEX IF NOT EXISTS "GrantUse_grantId_at_idx" ON "GrantUse"("grantId", "at");
CREATE INDEX IF NOT EXISTS "GrantUse_at_idx" ON "GrantUse"("at");
