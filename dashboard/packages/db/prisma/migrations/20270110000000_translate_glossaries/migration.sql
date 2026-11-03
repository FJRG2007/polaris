-- Translate glossaries: per person, per language pair, how each term is to
-- come out; and the words that person never wants translated.
--
-- Both tables are new and start empty. Every statement is written so that
-- running it a second time is a no-op.

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslateGlossary" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "fromLang" TEXT NOT NULL,
    "toLang" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "entries" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslateGlossary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslateKeepList" (
    "userId" UUID NOT NULL,
    "terms" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslateKeepList_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranslateGlossary_userId_fromLang_toLang_idx" ON "TranslateGlossary"("userId", "fromLang", "toLang");

-- AddForeignKey
ALTER TABLE "TranslateGlossary" DROP CONSTRAINT IF EXISTS "TranslateGlossary_userId_fkey";
ALTER TABLE "TranslateGlossary" ADD CONSTRAINT "TranslateGlossary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranslateKeepList" DROP CONSTRAINT IF EXISTS "TranslateKeepList_userId_fkey";
ALTER TABLE "TranslateKeepList" ADD CONSTRAINT "TranslateKeepList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
