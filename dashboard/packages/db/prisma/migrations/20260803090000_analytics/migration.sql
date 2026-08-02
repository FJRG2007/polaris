-- Visit analytics: who reached a deployed service, from where, and what they read.
--
-- Two sources write these tables and have to agree, which is why they share them
-- rather than each keeping their own: the edge's access log covers every deployed
-- service with no setup at all, and the tracker script adds what a log cannot see -
-- how long a visit lasted, the screen it was read on, and custom events.
--
-- Sessions are cookieless. The session id is a hash of a daily-rotating salt, the
-- site, the address and the user agent, so it is a natural primary key, it cannot be
-- reversed once the day turns over, and nobody is followed from one day to the next.
--
-- Raw sessions and events are pruned at the retention window; AnalyticsDay is not,
-- so a year of history costs a few rows a day instead of a row per request.

CREATE TABLE "AnalyticsSite" (
    "id" UUID NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "hostnames" TEXT NOT NULL DEFAULT '[]',
    "publicKey" TEXT NOT NULL,
    "trackerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsSite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnalyticsSite_publicKey_key" ON "AnalyticsSite"("publicKey");

CREATE UNIQUE INDEX "AnalyticsSite_scopeType_scopeId_key" ON "AnalyticsSite"("scopeType", "scopeId");

CREATE TABLE "AnalyticsSession" (
    "id" TEXT NOT NULL,
    "siteId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "browser" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "country" TEXT,
    "language" TEXT,
    "screen" TEXT,
    "referrerKind" TEXT NOT NULL,
    "referrerSource" TEXT,
    "campaign" TEXT,
    "medium" TEXT,

    CONSTRAINT "AnalyticsSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalyticsSession_siteId_startedAt_idx" ON "AnalyticsSession"("siteId", "startedAt");

CREATE INDEX "AnalyticsSession_lastSeenAt_idx" ON "AnalyticsSession"("lastSeenAt");

CREATE TABLE "AnalyticsEvent" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "path" TEXT NOT NULL,
    "rawPath" TEXT,
    "props" TEXT,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalyticsEvent_siteId_at_idx" ON "AnalyticsEvent"("siteId", "at");

CREATE INDEX "AnalyticsEvent_sessionId_idx" ON "AnalyticsEvent"("sessionId");

CREATE INDEX "AnalyticsEvent_siteId_kind_at_idx" ON "AnalyticsEvent"("siteId", "kind", "at");

CREATE TABLE "AnalyticsDay" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "dimension" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "bounces" INTEGER NOT NULL DEFAULT 0,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "measured" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnalyticsDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnalyticsDay_siteId_day_dimension_value_key" ON "AnalyticsDay"("siteId", "day", "dimension", "value");

CREATE INDEX "AnalyticsDay_siteId_day_idx" ON "AnalyticsDay"("siteId", "day");

ALTER TABLE "AnalyticsSession" ADD CONSTRAINT "AnalyticsSession_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AnalyticsSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalyticsDay" ADD CONSTRAINT "AnalyticsDay_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "AnalyticsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
