-- Telemetry performance: routes, their duration histograms, and slow samples.
-- Additive: one nullable column on TelemetryProject and three new tables.

-- AlterTable
ALTER TABLE "TelemetryProject" ADD COLUMN     "perfTargetMs" INTEGER;

-- CreateTable
CREATE TABLE "TelemetryPerfRoute" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "metric" TEXT NOT NULL DEFAULT 'duration',
    "count" INTEGER NOT NULL DEFAULT 0,
    "p50" DOUBLE PRECISION,
    "p75" DOUBLE PRECISION,
    "p95" DOUBLE PRECISION,
    "baselineP75" DOUBLE PRECISION,
    "targetMs" INTEGER,
    "issueId" UUID,
    "flaggedAt" TIMESTAMP(3),
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedAt" TIMESTAMP(3),

    CONSTRAINT "TelemetryPerfRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryPerfBucket" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "grain" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "sum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hist" INTEGER[],

    CONSTRAINT "TelemetryPerfBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryPerfSample" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "eventId" TEXT,
    "durationMs" DOUBLE PRECISION NOT NULL,
    "release" TEXT,
    "environment" TEXT,
    "url" TEXT,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryPerfSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelemetryPerfRoute_projectId_lastSeen_idx" ON "TelemetryPerfRoute"("projectId", "lastSeen");

-- CreateIndex
CREATE INDEX "TelemetryPerfRoute_projectId_count_idx" ON "TelemetryPerfRoute"("projectId", "count");

-- CreateIndex
CREATE INDEX "TelemetryPerfRoute_projectId_p50_idx" ON "TelemetryPerfRoute"("projectId", "p50");

-- CreateIndex
CREATE INDEX "TelemetryPerfRoute_projectId_p75_idx" ON "TelemetryPerfRoute"("projectId", "p75");

-- CreateIndex
CREATE INDEX "TelemetryPerfRoute_projectId_p95_idx" ON "TelemetryPerfRoute"("projectId", "p95");

-- CreateIndex
CREATE INDEX "TelemetryPerfRoute_projectId_name_idx" ON "TelemetryPerfRoute"("projectId", "name");

-- CreateIndex
CREATE INDEX "TelemetryPerfRoute_lastSeen_evaluatedAt_idx" ON "TelemetryPerfRoute"("lastSeen", "evaluatedAt");

-- CreateIndex
CREATE INDEX "TelemetryPerfRoute_issueId_idx" ON "TelemetryPerfRoute"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryPerfRoute_projectId_op_name_key" ON "TelemetryPerfRoute"("projectId", "op", "name");

-- CreateIndex
CREATE INDEX "TelemetryPerfBucket_grain_at_idx" ON "TelemetryPerfBucket"("grain", "at");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryPerfBucket_routeId_metric_grain_at_key" ON "TelemetryPerfBucket"("routeId", "metric", "grain", "at");

-- CreateIndex
CREATE INDEX "TelemetryPerfSample_routeId_durationMs_idx" ON "TelemetryPerfSample"("routeId", "durationMs");

-- CreateIndex
CREATE INDEX "TelemetryPerfSample_projectId_at_idx" ON "TelemetryPerfSample"("projectId", "at");

-- AddForeignKey
ALTER TABLE "TelemetryPerfRoute" ADD CONSTRAINT "TelemetryPerfRoute_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TelemetryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryPerfRoute" ADD CONSTRAINT "TelemetryPerfRoute_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "TelemetryIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryPerfBucket" ADD CONSTRAINT "TelemetryPerfBucket_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TelemetryPerfRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryPerfSample" ADD CONSTRAINT "TelemetryPerfSample_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TelemetryPerfRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

