-- Personal drives: the two fields that turn a Drive access rule into something
-- one person hands another - when it lapses, and what they said when they sent it.

-- AlterTable
ALTER TABLE "DriveAcl" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "note" TEXT;
