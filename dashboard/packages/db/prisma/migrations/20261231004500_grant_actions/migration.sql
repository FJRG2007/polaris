-- A grant names which of its subject's actions it allows. Additive: the column
-- defaults to empty, which the code reads as "everything the capability
-- reaches", and the backfill below spells that out for every existing Places
-- grant so a current guest keeps exactly what they had.
ALTER TABLE "AccessGrant" ADD COLUMN IF NOT EXISTS "actions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "AccessGrant" SET "actions" = ARRAY['open', 'close', 'operate']
WHERE "subjectType" = 'place.device' AND "capability" = 'control' AND "actions" = ARRAY[]::TEXT[];

UPDATE "AccessGrant" SET "actions" = ARRAY['watch']
WHERE "subjectType" = 'place.camera' AND "actions" = ARRAY[]::TEXT[];
