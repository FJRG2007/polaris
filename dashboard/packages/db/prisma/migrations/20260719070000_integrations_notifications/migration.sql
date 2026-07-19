-- AlterTable
ALTER TABLE "DriveItemMeta" ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" TEXT NOT NULL DEFAULT '{}',
    "encryptedSecret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "installedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Integration_provider_key" ON "Integration"("provider");

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "metadata" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateTable
CREATE TABLE "FileScan" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'virustotal',
    "submissionId" TEXT,
    "connectionId" TEXT,
    "path" TEXT,
    "sha256" TEXT,
    "verdict" TEXT NOT NULL DEFAULT 'pending',
    "malicious" INTEGER NOT NULL DEFAULT 0,
    "suspicious" INTEGER NOT NULL DEFAULT 0,
    "permalink" TEXT,
    "action" TEXT NOT NULL DEFAULT 'none',
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileScan_submissionId_idx" ON "FileScan"("submissionId");

-- CreateIndex
CREATE INDEX "FileScan_sha256_idx" ON "FileScan"("sha256");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
