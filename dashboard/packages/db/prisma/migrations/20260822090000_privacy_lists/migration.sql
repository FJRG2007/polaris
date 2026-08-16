-- AlterTable
ALTER TABLE "UserPrivacy" ADD COLUMN     "email" TEXT NOT NULL DEFAULT 'nobody',
ADD COLUMN     "phone" TEXT NOT NULL DEFAULT 'nobody';

-- CreateTable
CREATE TABLE "PrivacyList" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacyList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyListMember" (
    "listId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "PrivacyListMember_pkey" PRIMARY KEY ("listId","userId")
);

-- CreateTable
CREATE TABLE "PrivacyFieldList" (
    "userId" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "listId" UUID NOT NULL,

    CONSTRAINT "PrivacyFieldList_pkey" PRIMARY KEY ("userId","field")
);

-- CreateIndex
CREATE INDEX "PrivacyList_userId_idx" ON "PrivacyList"("userId");

-- CreateIndex
CREATE INDEX "PrivacyListMember_userId_idx" ON "PrivacyListMember"("userId");

-- CreateIndex
CREATE INDEX "PrivacyFieldList_listId_idx" ON "PrivacyFieldList"("listId");

-- AddForeignKey
ALTER TABLE "PrivacyList" ADD CONSTRAINT "PrivacyList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyListMember" ADD CONSTRAINT "PrivacyListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "PrivacyList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyListMember" ADD CONSTRAINT "PrivacyListMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyFieldList" ADD CONSTRAINT "PrivacyFieldList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyFieldList" ADD CONSTRAINT "PrivacyFieldList_listId_fkey" FOREIGN KEY ("listId") REFERENCES "PrivacyList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
