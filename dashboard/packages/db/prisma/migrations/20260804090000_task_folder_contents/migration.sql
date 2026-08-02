-- Pages and sprints that belong to a folder, not only to a whole space.
--
-- Once folders nest, a folder is how somebody keeps a project: a client holds
-- projects, a project holds its lists. The things a project actually produces
-- were still space-wide, so a page written for one client sat in the same wiki
-- as every other client's, and a sprint planning one project appeared on every
-- other project's board.
--
-- A null folderId keeps the old meaning exactly - a page or a sprint the whole
-- space shares - so nothing that exists today moves or changes.
--
-- The link clears rather than cascades on delete: deleting a folder lifts what
-- is inside it to the folder above (see deleteFolder), and a page nobody meant
-- to destroy must not disappear because the arrangement around it changed.

-- AlterTable
ALTER TABLE "TaskDoc" ADD COLUMN "folderId" UUID;

-- AlterTable
ALTER TABLE "TaskSprint" ADD COLUMN "folderId" UUID;

-- CreateIndex
CREATE INDEX "TaskDoc_folderId_idx" ON "TaskDoc"("folderId");

-- CreateIndex
CREATE INDEX "TaskSprint_folderId_idx" ON "TaskSprint"("folderId");

-- AddForeignKey
ALTER TABLE "TaskDoc" ADD CONSTRAINT "TaskDoc_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TaskFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSprint" ADD CONSTRAINT "TaskSprint_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TaskFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
