-- What the owner asked a connected TV to do, and what the TV says it did.
CREATE TABLE IF NOT EXISTS "TvPreference" (
    "apiKeyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "desired" JSONB,
    "choice" UUID,
    "askedAt" TIMESTAMP(3),
    "applied" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TvPreference_pkey" PRIMARY KEY ("apiKeyId")
);

CREATE INDEX IF NOT EXISTS "TvPreference_userId_idx" ON "TvPreference"("userId");

ALTER TABLE "TvPreference" DROP CONSTRAINT IF EXISTS "TvPreference_apiKeyId_fkey";
ALTER TABLE "TvPreference" ADD CONSTRAINT "TvPreference_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
