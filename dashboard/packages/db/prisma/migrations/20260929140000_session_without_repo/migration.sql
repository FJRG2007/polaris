-- A session no longer has to be about a repository, and no longer has to run on
-- the machine belonging to whoever started it.
--
-- A null `repoId` is somebody opening an agent on a machine of their own with
-- nothing checked out: no task, no repository, no branch. Such a session
-- resolves its access through `startedById` rather than through the
-- repository's owner.
--
-- `sharedHome` is that machine being the one everybody shares rather than the
-- account's own. It is stored rather than resolved because which machine a
-- session opened on is a fact about that session and must not change under it.
--
-- Widening only: every existing row keeps the repository it has and runs where
-- it always did.
ALTER TABLE "AgentSession" ADD COLUMN "sharedHome" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "repoId" DROP NOT NULL;
