-- CreateTable
CREATE TABLE "Camera" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "zone" TEXT,
    "vendor" TEXT NOT NULL DEFAULT 'generic',
    "model" TEXT,
    "address" TEXT NOT NULL,
    "rtspPort" INTEGER NOT NULL DEFAULT 554,
    "onvifPort" INTEGER,
    "mainPath" TEXT,
    "subPath" TEXT,
    "username" TEXT,
    "encryptedSecret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "reachVia" TEXT NOT NULL DEFAULT 'direct',
    "relayTargetId" UUID,
    "detector" TEXT NOT NULL DEFAULT 'camera',
    "detectorTargetId" UUID,
    "detectionConfig" TEXT NOT NULL DEFAULT '{}',
    "recording" TEXT NOT NULL DEFAULT 'off',
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraEvent" (
    "id" UUID NOT NULL,
    "cameraId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "score" INTEGER,
    "stillKey" TEXT,
    "clipId" UUID,
    "ackedAt" TIMESTAMP(3),
    "ackedById" UUID,

    CONSTRAINT "CameraEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraClip" (
    "id" UUID NOT NULL,
    "cameraId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL DEFAULT 'motion',
    "connectionId" UUID,
    "path" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomePerson" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "notify" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomePerson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Camera_installedAppId_idx" ON "Camera"("installedAppId");

-- CreateIndex
CREATE INDEX "Camera_installedAppId_zone_idx" ON "Camera"("installedAppId", "zone");

-- CreateIndex
CREATE INDEX "CameraEvent_cameraId_at_idx" ON "CameraEvent"("cameraId", "at");

-- CreateIndex
CREATE INDEX "CameraEvent_at_idx" ON "CameraEvent"("at");

-- CreateIndex
CREATE INDEX "CameraEvent_cameraId_kind_at_idx" ON "CameraEvent"("cameraId", "kind", "at");

-- CreateIndex
CREATE INDEX "CameraClip_cameraId_startedAt_idx" ON "CameraClip"("cameraId", "startedAt");

-- CreateIndex
CREATE INDEX "CameraClip_startedAt_idx" ON "CameraClip"("startedAt");

-- CreateIndex
CREATE INDEX "HomePerson_installedAppId_idx" ON "HomePerson"("installedAppId");

-- CreateIndex
CREATE UNIQUE INDEX "HomePerson_installedAppId_name_key" ON "HomePerson"("installedAppId", "name");

-- AddForeignKey
ALTER TABLE "CameraEvent" ADD CONSTRAINT "CameraEvent_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraEvent" ADD CONSTRAINT "CameraEvent_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "CameraClip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraClip" ADD CONSTRAINT "CameraClip_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

