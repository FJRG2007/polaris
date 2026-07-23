-- Scheduling, visitor presence, self-service deletes, and config templates for
-- drop points. Additive columns on FileRequest plus two new tables.
ALTER TABLE "FileRequest" ADD COLUMN "startsAt" TIMESTAMP(3);
ALTER TABLE "FileRequest" ADD COLUMN "allowUploaderDelete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FileRequest" ADD COLUMN "uploaderDeleteWindowSeconds" INTEGER;

CREATE TABLE "FileRequestVisit" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "visitorKey" TEXT NOT NULL,
    "ip" TEXT,
    "ipHash" TEXT,
    "userId" UUID,
    "userAgent" TEXT,
    "uploadCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileRequestVisit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FileRequestVisit_requestId_visitorKey_key" ON "FileRequestVisit"("requestId", "visitorKey");
CREATE INDEX "FileRequestVisit_requestId_idx" ON "FileRequestVisit"("requestId");
ALTER TABLE "FileRequestVisit" ADD CONSTRAINT "FileRequestVisit_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "FileRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FileRequestVisit" ADD CONSTRAINT "FileRequestVisit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "DropPointTemplate" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DropPointTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DropPointTemplate_ownerId_idx" ON "DropPointTemplate"("ownerId");
ALTER TABLE "DropPointTemplate" ADD CONSTRAINT "DropPointTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
