-- Privacy: who can find an account by its whole email address and by its whole
-- phone number, each its own setting beside `discoverable` (username and name).
--
-- Until now `discoverable` decided every way of being found, the address
-- included. So nobody loses what they chose, the new settings start as a copy
-- of it: the same audience, and the same people where it names some. A named
-- list is shared, as it is between any two settings; a setting's own unnamed
-- list is copied, because each setting edits its own. An account that never
-- chose (null) keeps following the administrator's default, and the
-- administrator's default for `discoverable`, if one was set, is copied too.
--
-- Additive and rerunnable: every statement skips what is already there. To
-- undo: DELETE FROM "PrivacyFieldList" WHERE "field" IN ('findByEmail',
-- 'findByPhone'); DELETE FROM "PrivacyList" WHERE "name" = '' AND NOT EXISTS
-- (a "PrivacyFieldList" row naming it); DELETE FROM "Setting" WHERE "key" IN
-- ('privacy.defaults.findByEmail', 'privacy.defaults.findByPhone'); then drop
-- the two columns.

ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "findByEmail" TEXT;
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "findByPhone" TEXT;

-- A named list: the new settings point at the same one.
INSERT INTO "PrivacyFieldList" ("userId", "field", "listId")
SELECT link."userId", target."field", link."listId"
FROM "PrivacyFieldList" link
JOIN "PrivacyList" list ON list."id" = link."listId" AND list."name" <> ''
CROSS JOIN (VALUES ('findByEmail'), ('findByPhone')) AS target ("field")
WHERE link."field" = 'discoverable'
ON CONFLICT ("userId", "field") DO NOTHING;

-- A setting's own unnamed list: a copy of it, with the same people.
WITH source AS (
    SELECT link."userId", link."listId" AS "fromId", target."field", gen_random_uuid() AS "toId"
    FROM "PrivacyFieldList" link
    JOIN "PrivacyList" list ON list."id" = link."listId" AND list."name" = ''
    CROSS JOIN (VALUES ('findByEmail'), ('findByPhone')) AS target ("field")
    WHERE link."field" = 'discoverable'
      AND NOT EXISTS (
          SELECT 1 FROM "PrivacyFieldList" taken
          WHERE taken."userId" = link."userId" AND taken."field" = target."field"
      )
),
lists AS (
    INSERT INTO "PrivacyList" ("id", "userId", "name", "createdAt", "updatedAt")
    SELECT "toId", "userId", '', now(), now() FROM source
),
members AS (
    INSERT INTO "PrivacyListMember" ("listId", "userId")
    SELECT source."toId", member."userId"
    FROM source
    JOIN "PrivacyListMember" member ON member."listId" = source."fromId"
)
INSERT INTO "PrivacyFieldList" ("userId", "field", "listId")
SELECT "userId", "field", "toId" FROM source
ON CONFLICT ("userId", "field") DO NOTHING;

-- The audience itself.
UPDATE "UserPrivacy" SET "findByEmail" = "discoverable"
WHERE "findByEmail" IS NULL AND "discoverable" IS NOT NULL;
UPDATE "UserPrivacy" SET "findByPhone" = "discoverable"
WHERE "findByPhone" IS NULL AND "discoverable" IS NOT NULL;

-- The administrator's default for accounts that never chose.
INSERT INTO "Setting" ("id", "key", "value", "scope", "userId")
SELECT gen_random_uuid(), target."key", setting."value", setting."scope", setting."userId"
FROM "Setting" setting
CROSS JOIN (VALUES ('privacy.defaults.findByEmail'), ('privacy.defaults.findByPhone')) AS target ("key")
WHERE setting."key" = 'privacy.defaults.discoverable'
ON CONFLICT ("key") DO NOTHING;
