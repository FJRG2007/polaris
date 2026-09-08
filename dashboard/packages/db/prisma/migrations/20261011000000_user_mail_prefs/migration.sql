-- How one person reads mail, as opposed to how one mailbox is set up.
--
-- Nullable with no default and no backfill: absent means "has never opened that
-- screen", which every reader is until they do, and @polaris/core answers a null
-- column with the same defaults the code used as constants before it existed.
-- So this migration changes nobody's Mail.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mailPrefs" TEXT;
