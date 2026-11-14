-- A masked hint per stored model key, so the keys screens can tell two keys of
-- one provider apart. Additive and nullable: existing rows are filled in by the
-- listing the first time it reads them, since only the app can decrypt a key.

-- AlterTable
ALTER TABLE "UserModelKey" ADD COLUMN IF NOT EXISTS "keyHint" TEXT;
