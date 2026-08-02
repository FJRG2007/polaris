-- Folders that nest, and access granted on one branch of a space.
--
-- A single flat layer of folders only fits a team whose work is already flat.
-- The arrangement people actually keep has depth - an agency holds clients, a
-- client holds projects, a project holds its lists - and expressing that with
-- one space per client means duplicating the statuses, tags, custom fields and
-- reference prefix that a space owns, for every client. TaskFolder.parentId is
-- the cheaper answer: the same space, arranged as deeply as the work is.
--
-- TaskFolderMember is what the nesting makes possible. Until now the smallest
-- thing somebody could be invited to was a whole space, so showing one client
-- their project meant showing them every other client beside it. A grant on a
-- folder reaches that folder's whole branch and nothing outside it, uses the
-- same guest/member/admin vocabulary a space membership uses, and only ever
-- adds to a space-level role rather than reducing one.
--
-- The parent link cascades on delete at the database, but the application lifts
-- a deleted folder's children and lists to its parent first (see deleteFolder),
-- so removing an arrangement never takes the work inside it down with it. The
-- cascade is the backstop for a row deleted out from under the application, not
-- the intended path.

-- AlterTable
ALTER TABLE "TaskFolder" ADD COLUMN "parentId" UUID;

-- CreateTable
CREATE TABLE "TaskFolderMember" (
    "id" UUID NOT NULL,
    "folderId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskFolderMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskFolder_parentId_idx" ON "TaskFolder"("parentId");

-- CreateIndex
CREATE INDEX "TaskFolderMember_userId_idx" ON "TaskFolderMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskFolderMember_folderId_userId_key" ON "TaskFolderMember"("folderId", "userId");

-- AddForeignKey
ALTER TABLE "TaskFolder" ADD CONSTRAINT "TaskFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TaskFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFolderMember" ADD CONSTRAINT "TaskFolderMember_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TaskFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFolderMember" ADD CONSTRAINT "TaskFolderMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
