-- Polaris TV reports its build number beside its version.
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "clientBuild" INTEGER;

-- The one update each connected TV was last asked to install.
CREATE TABLE IF NOT EXISTS "TvUpdateRequest" (
    "apiKeyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "versionName" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TvUpdateRequest_pkey" PRIMARY KEY ("apiKeyId")
);

CREATE INDEX IF NOT EXISTS "TvUpdateRequest_userId_idx" ON "TvUpdateRequest"("userId");

ALTER TABLE "TvUpdateRequest" DROP CONSTRAINT IF EXISTS "TvUpdateRequest_apiKeyId_fkey";
ALTER TABLE "TvUpdateRequest" ADD CONSTRAINT "TvUpdateRequest_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
