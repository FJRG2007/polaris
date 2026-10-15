-- Status pages (apps/status-pages): pages, their components and checks, the
-- checks' recent results and daily rollups, incidents and maintenance. The
-- `status.manage` permission needs no row: only admin holds it, through its
-- wildcard.
--
-- Additive only, and every statement is written so that running it a second
-- time is a no-op. To reverse, drop the eight "Status*" tables.

CREATE TABLE IF NOT EXISTS "StatusPage" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "customDomain" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StatusPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatusComponent" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatusComponent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatusCheck" (
    "id" UUID NOT NULL,
    "componentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "port" INTEGER,
    "expectStatus" INTEGER,
    "keyword" TEXT NOT NULL DEFAULT '',
    "dnsType" TEXT,
    "dnsExpect" TEXT NOT NULL DEFAULT '',
    "intervalSec" INTEGER NOT NULL DEFAULT 60,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatus" TEXT,
    "lastLatencyMs" INTEGER,
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatusCheck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatusSample" (
    "id" UUID NOT NULL,
    "checkId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    CONSTRAINT "StatusSample_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatusDay" (
    "checkId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "up" INTEGER NOT NULL DEFAULT 0,
    "latencySum" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "StatusDay_pkey" PRIMARY KEY ("checkId", "day")
);

CREATE TABLE IF NOT EXISTS "StatusIncident" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'investigating',
    "impact" TEXT NOT NULL DEFAULT 'minor',
    "componentIds" UUID[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StatusIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatusIncidentUpdate" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatusIncidentUpdate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatusMaintenance" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "componentIds" UUID[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatusMaintenance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StatusPage_slug_key" ON "StatusPage"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "StatusPage_customDomain_key" ON "StatusPage"("customDomain");
CREATE INDEX IF NOT EXISTS "StatusPage_createdAt_idx" ON "StatusPage"("createdAt");
CREATE INDEX IF NOT EXISTS "StatusComponent_pageId_position_idx" ON "StatusComponent"("pageId", "position");
CREATE INDEX IF NOT EXISTS "StatusCheck_enabled_nextRunAt_idx" ON "StatusCheck"("enabled", "nextRunAt");
CREATE INDEX IF NOT EXISTS "StatusCheck_componentId_idx" ON "StatusCheck"("componentId");
CREATE INDEX IF NOT EXISTS "StatusSample_checkId_at_idx" ON "StatusSample"("checkId", "at");
CREATE INDEX IF NOT EXISTS "StatusSample_at_idx" ON "StatusSample"("at");
CREATE INDEX IF NOT EXISTS "StatusDay_day_idx" ON "StatusDay"("day");
CREATE INDEX IF NOT EXISTS "StatusIncident_pageId_startedAt_idx" ON "StatusIncident"("pageId", "startedAt");
CREATE INDEX IF NOT EXISTS "StatusIncident_pageId_resolvedAt_idx" ON "StatusIncident"("pageId", "resolvedAt");
CREATE INDEX IF NOT EXISTS "StatusIncidentUpdate_incidentId_createdAt_idx" ON "StatusIncidentUpdate"("incidentId", "createdAt");
CREATE INDEX IF NOT EXISTS "StatusMaintenance_pageId_endsAt_idx" ON "StatusMaintenance"("pageId", "endsAt");

DO $$ BEGIN
    ALTER TABLE "StatusComponent" ADD CONSTRAINT "StatusComponent_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "StatusPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "StatusCheck" ADD CONSTRAINT "StatusCheck_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "StatusComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "StatusSample" ADD CONSTRAINT "StatusSample_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "StatusCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "StatusDay" ADD CONSTRAINT "StatusDay_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "StatusCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "StatusIncident" ADD CONSTRAINT "StatusIncident_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "StatusPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "StatusIncidentUpdate" ADD CONSTRAINT "StatusIncidentUpdate_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "StatusIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "StatusMaintenance" ADD CONSTRAINT "StatusMaintenance_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "StatusPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
