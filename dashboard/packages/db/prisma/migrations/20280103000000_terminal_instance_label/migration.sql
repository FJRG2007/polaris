-- What an owner renamed a Polaris Terminal to on the web screen. Additive and
-- nullable: a row without one shows the name the terminal reports.
-- Reverse: ALTER TABLE "TerminalInstance" DROP COLUMN "label";
ALTER TABLE "TerminalInstance" ADD COLUMN IF NOT EXISTS "label" TEXT;
