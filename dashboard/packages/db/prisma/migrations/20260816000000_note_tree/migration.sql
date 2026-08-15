-- Notes nest.
--
-- A flat list is fine for ten notes and a filing problem at thirty, and the
-- shape people reach for is the one a notebook already has: a few subjects with
-- pages under each. Any note can hold others, so there is no second kind of
-- thing to create and keep in step.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a note frees its children
-- instead of taking them with it. The text under a heading is not owned by the
-- heading, and a delete that quietly removed a subtree would be the one
-- destructive action in Polaris that never said how much it was about to take.
--
-- Additive: every existing note keeps a null parent, which is the top level.

ALTER TABLE "Note" ADD COLUMN "parentId" UUID;

CREATE INDEX "Note_userId_parentId_idx" ON "Note"("userId", "parentId");

ALTER TABLE "Note" ADD CONSTRAINT "Note_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Note"("id") ON DELETE SET NULL ON UPDATE CASCADE;
