-- CreateTable
CREATE TABLE "ContactName" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "nickname" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactName_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactName_ownerId_idx" ON "ContactName"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactName_ownerId_subjectId_key" ON "ContactName"("ownerId", "subjectId");

-- AddForeignKey
ALTER TABLE "ContactName" ADD CONSTRAINT "ContactName_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactName" ADD CONSTRAINT "ContactName_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

