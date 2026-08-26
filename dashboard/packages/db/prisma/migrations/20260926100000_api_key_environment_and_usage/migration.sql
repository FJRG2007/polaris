-- Keys become something a person can keep track of.
--
-- Three things the list could not say, and each of them is why somebody ends up
-- with fourteen keys and no idea which two matter. Which setup a key was made
-- for is now a label on the row - it narrows nothing, there being one instance
-- behind both, and that is exactly what makes it safe to sort by. The last
-- characters of the secret are kept so a row can be matched against the value in
-- a password manager without ever showing the value again; four characters of a
-- random token identify nothing on their own, which is why every credential list
-- in the world prints them.
--
-- And how much a key is actually being used, which until now was one timestamp:
-- a key used once in April and a key answering a thousand calls an hour both
-- read as "last used today". The counter is per key per day, addressed by its
-- primary key so a call costs one upsert and never a scan.

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'production';
ALTER TABLE "ApiKey" ADD COLUMN "tail" TEXT;
-- And a line saying why the key exists, which a name cannot carry and nobody
-- remembers a year later.
ALTER TABLE "ApiKey" ADD COLUMN "description" TEXT;

-- CreateTable
CREATE TABLE "ApiKeyUsage" (
    "apiKeyId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiKeyUsage_pkey" PRIMARY KEY ("apiKeyId","day")
);

-- AddForeignKey
ALTER TABLE "ApiKeyUsage" ADD CONSTRAINT "ApiKeyUsage_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
