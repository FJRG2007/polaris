-- CreateTable
CREATE TABLE "AlertRule" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "placeId" UUID,
    "cameraId" UUID,
    "name" TEXT NOT NULL,
    "kinds" TEXT NOT NULL DEFAULT '["person"]',
    "label" TEXT,
    "hours" TEXT,
    "recipients" TEXT NOT NULL DEFAULT '[]',
    "channelId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertRule_installedAppId_idx" ON "AlertRule"("installedAppId");

-- CreateIndex
CREATE INDEX "AlertRule_placeId_idx" ON "AlertRule"("placeId");

-- CreateIndex
CREATE INDEX "AlertRule_cameraId_idx" ON "AlertRule"("cameraId");
