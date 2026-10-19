-- Pictures and files given to Polar, one person's each.
CREATE TABLE "PolarAttachment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PolarAttachment_userId_createdAt_idx" ON "PolarAttachment"("userId", "createdAt");

ALTER TABLE "PolarAttachment" ADD CONSTRAINT "PolarAttachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
