-- Groups were created without an owner, so the column the rest of the feature
-- reads was null on every one of them: their creator was refused when renaming
-- one, no crown showed against anybody, and a group could not be handed over.
-- Creation sets it now; this is the groups that already exist, whose owner is
-- whoever started them.
UPDATE "ChatChannel"
SET "ownerId" = "createdById"
WHERE "kind" = 'group' AND "ownerId" IS NULL AND "createdById" IS NOT NULL;
