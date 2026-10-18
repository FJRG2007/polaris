-- Whether people who join a conversation later can read what was said before
-- they joined. Additive only, and both defaults keep every existing space,
-- channel and group exactly as it reads today: everything visible.
--
-- The join time it is measured against is the membership row's existing
-- "createdAt", so no backfill is needed.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "ChatSpace" ADD COLUMN IF NOT EXISTS "newcomerHistory" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "newcomerHistory" TEXT NOT NULL DEFAULT 'inherit';
