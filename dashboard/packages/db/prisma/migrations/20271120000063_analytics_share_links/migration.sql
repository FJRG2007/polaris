-- A site's numbers on a public address, optionally behind a password.
CREATE TABLE IF NOT EXISTS "AnalyticsShareLink" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "createdById" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "tokenHash" TEXT NOT NULL,
    "encryptedToken" BYTEA NOT NULL,
    "tokenNonce" BYTEA NOT NULL,
    "tokenKeyId" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT,
    "range" TEXT NOT NULL DEFAULT '30d',
    "allowEmbed" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsShareLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AnalyticsShareLink_tokenHash_key" ON "AnalyticsShareLink"("tokenHash");
CREATE INDEX IF NOT EXISTS "AnalyticsShareLink_siteId_idx" ON "AnalyticsShareLink"("siteId");

ALTER TABLE "AnalyticsShareLink" DROP CONSTRAINT IF EXISTS "AnalyticsShareLink_siteId_fkey";
ALTER TABLE "AnalyticsShareLink" ADD CONSTRAINT "AnalyticsShareLink_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
