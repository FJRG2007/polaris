-- The Translate app's history: each person's recent translations, theirs alone.
CREATE TABLE IF NOT EXISTS "TranslateHistory" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceText" TEXT NOT NULL,
    "targetText" TEXT NOT NULL,
    "fromLang" TEXT NOT NULL,
    "toLang" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslateHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TranslateHistory_userId_createdAt_idx" ON "TranslateHistory"("userId", "createdAt");

ALTER TABLE "TranslateHistory" DROP CONSTRAINT IF EXISTS "TranslateHistory_userId_fkey";
ALTER TABLE "TranslateHistory" ADD CONSTRAINT "TranslateHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Give the seeded member and viewer roles `translate.use`, the way they hold
-- `crm.use`. Only where it is missing, so a role an operator narrowed on
-- purpose keeps everything else it says.
UPDATE "Role"
SET "permissions" = (("permissions"::jsonb) || '["translate.use"]'::jsonb)::text
WHERE "isSystem" = true
  AND "name" IN ('member', 'viewer')
  AND jsonb_typeof("permissions"::jsonb) = 'array'
  AND NOT (("permissions"::jsonb) @> '["translate.use"]'::jsonb);
