-- What an environment is for, and the record of promoting one into another.
-- Both are new: every existing environment keeps a null stage, which reads as
-- production on the default environment and as unset elsewhere. To reverse,
-- drop the table and the column.

ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "stage" TEXT;

CREATE TABLE IF NOT EXISTS "EnvironmentPromotion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceEnvironmentId" UUID NOT NULL,
    "targetEnvironmentId" UUID NOT NULL,
    "sourceName" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "includeData" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'running',
    "steps" TEXT NOT NULL DEFAULT '[]',
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EnvironmentPromotion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EnvironmentPromotion_projectId_createdAt_idx" ON "EnvironmentPromotion"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "EnvironmentPromotion_targetEnvironmentId_status_idx" ON "EnvironmentPromotion"("targetEnvironmentId", "status");

DO $$ BEGIN
    ALTER TABLE "EnvironmentPromotion" ADD CONSTRAINT "EnvironmentPromotion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
