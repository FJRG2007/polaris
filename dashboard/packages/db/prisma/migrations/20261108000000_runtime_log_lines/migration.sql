-- Kept runtime logs.
--
-- What each running service prints, captured once a minute so it survives the
-- container being replaced by a deploy, and bounded by age and by a count per
-- service. Nothing existing changes.
CREATE TABLE IF NOT EXISTS "RuntimeLogLine" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "container" TEXT NOT NULL,
    "stamp" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "RuntimeLogLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RuntimeLogLine_applicationId_stamp_idx" ON "RuntimeLogLine"("applicationId", "stamp");
CREATE INDEX IF NOT EXISTS "RuntimeLogLine_applicationId_container_stamp_idx" ON "RuntimeLogLine"("applicationId", "container", "stamp");
CREATE INDEX IF NOT EXISTS "RuntimeLogLine_at_idx" ON "RuntimeLogLine"("at");

ALTER TABLE "RuntimeLogLine" DROP CONSTRAINT IF EXISTS "RuntimeLogLine_applicationId_fkey";
ALTER TABLE "RuntimeLogLine" ADD CONSTRAINT "RuntimeLogLine_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
