-- Photos and videos sent to be seen once, on a phone.
--
-- Additive only: three nullable or defaulted columns, and two new tables.
-- Every file already sent stays an ordinary one.
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "viewOnce" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "viewSeconds" INTEGER;
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "captured" TEXT;

CREATE TABLE IF NOT EXISTS "ChatAttachmentOpen" (
    "attachmentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAttachmentOpen_pkey" PRIMARY KEY ("attachmentId","userId")
);
CREATE INDEX IF NOT EXISTS "ChatAttachmentOpen_userId_idx" ON "ChatAttachmentOpen"("userId");
ALTER TABLE "ChatAttachmentOpen" DROP CONSTRAINT IF EXISTS "ChatAttachmentOpen_attachmentId_fkey";
ALTER TABLE "ChatAttachmentOpen" ADD CONSTRAINT "ChatAttachmentOpen_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "ChatAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatAttachmentOpen" DROP CONSTRAINT IF EXISTS "ChatAttachmentOpen_userId_fkey";
ALTER TABLE "ChatAttachmentOpen" ADD CONSTRAINT "ChatAttachmentOpen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MobileDeviceKey" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "publicKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobileDeviceKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MobileDeviceKey_publicKey_key" ON "MobileDeviceKey"("publicKey");
CREATE INDEX IF NOT EXISTS "MobileDeviceKey_userId_lastUsedAt_idx" ON "MobileDeviceKey"("userId", "lastUsedAt");
ALTER TABLE "MobileDeviceKey" DROP CONSTRAINT IF EXISTS "MobileDeviceKey_userId_fkey";
ALTER TABLE "MobileDeviceKey" ADD CONSTRAINT "MobileDeviceKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
