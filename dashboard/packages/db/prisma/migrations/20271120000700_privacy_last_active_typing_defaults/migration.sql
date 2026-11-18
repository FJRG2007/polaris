-- Privacy: "last seen" time and typing as their own settings, and every
-- audience able to say "never chosen" so it follows the administrator's default.
--
-- A null audience now means the person never chose, the way `followers`
-- already worked. Until now every save wrote all the columns, so the only
-- signal left of a real choice is a value that differs from the code's default:
-- those are kept as they are, and a value equal to the default is cleared, so
-- that account follows whatever the administrator sets from now on. While no
-- default is set the code's default applies, which is the value that was there.
--
-- Additive and rerunnable: each statement is a no-op the second time. To undo,
-- per column: UPDATE ... SET col = '<default>' WHERE col IS NULL; then
-- ALTER COLUMN col SET DEFAULT '<default>', ALTER COLUMN col SET NOT NULL, and
-- drop "lastActive" and "typing".

ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "lastActive" TEXT;
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "typing" TEXT;

ALTER TABLE "UserPrivacy" ALTER COLUMN "discoverable" DROP DEFAULT, ALTER COLUMN "discoverable" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "profile" DROP DEFAULT, ALTER COLUMN "profile" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "lastSeen" DROP DEFAULT, ALTER COLUMN "lastSeen" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "readReceipts" DROP DEFAULT, ALTER COLUMN "readReceipts" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "avatar" DROP DEFAULT, ALTER COLUMN "avatar" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "photoFullSize" DROP DEFAULT, ALTER COLUMN "photoFullSize" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "fullName" DROP DEFAULT, ALTER COLUMN "fullName" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "email" DROP DEFAULT, ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "phone" DROP DEFAULT, ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "companies" DROP DEFAULT, ALTER COLUMN "companies" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "friendRequests" DROP DEFAULT, ALTER COLUMN "friendRequests" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "fileTransfers" DROP DEFAULT, ALTER COLUMN "fileTransfers" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "calls" DROP DEFAULT, ALTER COLUMN "calls" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "forwarding" DROP DEFAULT, ALTER COLUMN "forwarding" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "activity" DROP DEFAULT, ALTER COLUMN "activity" DROP NOT NULL;
ALTER TABLE "UserPrivacy" ALTER COLUMN "badges" DROP DEFAULT, ALTER COLUMN "badges" DROP NOT NULL;

-- Backfill: a value equal to the code's default reads as never chosen.
UPDATE "UserPrivacy" SET "discoverable" = NULL WHERE "discoverable" = 'everyone';
UPDATE "UserPrivacy" SET "profile" = NULL WHERE "profile" = 'everyone';
UPDATE "UserPrivacy" SET "lastSeen" = NULL WHERE "lastSeen" = 'everyone';
UPDATE "UserPrivacy" SET "readReceipts" = NULL WHERE "readReceipts" = 'everyone';
UPDATE "UserPrivacy" SET "avatar" = NULL WHERE "avatar" = 'everyone';
UPDATE "UserPrivacy" SET "photoFullSize" = NULL WHERE "photoFullSize" = 'everyone';
UPDATE "UserPrivacy" SET "fullName" = NULL WHERE "fullName" = 'nobody';
UPDATE "UserPrivacy" SET "email" = NULL WHERE "email" = 'nobody';
UPDATE "UserPrivacy" SET "phone" = NULL WHERE "phone" = 'nobody';
UPDATE "UserPrivacy" SET "companies" = NULL WHERE "companies" = 'everyone';
UPDATE "UserPrivacy" SET "friendRequests" = NULL WHERE "friendRequests" = 'everyone';
UPDATE "UserPrivacy" SET "fileTransfers" = NULL WHERE "fileTransfers" = 'friends';
UPDATE "UserPrivacy" SET "calls" = NULL WHERE "calls" = 'friends';
UPDATE "UserPrivacy" SET "forwarding" = NULL WHERE "forwarding" = 'everyone';
UPDATE "UserPrivacy" SET "activity" = NULL WHERE "activity" = 'everyone';
UPDATE "UserPrivacy" SET "badges" = NULL WHERE "badges" = 'everyone';
