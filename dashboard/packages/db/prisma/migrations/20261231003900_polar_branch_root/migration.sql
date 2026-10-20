-- The chat a Polar branch was first copied from, so deleting a chat looks for
-- the files it shares only among its own branches. One nullable column and its
-- index; existing chats read as having no branches.
--
-- Every statement is written so that running it a second time is a no-op.
ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "branchRootId" UUID;

CREATE INDEX IF NOT EXISTS "PolarThread_branchRootId_idx" ON "PolarThread"("branchRootId");
