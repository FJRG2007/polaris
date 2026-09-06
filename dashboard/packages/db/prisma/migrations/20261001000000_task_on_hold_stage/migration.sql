-- Every space starts with an "On hold" stage, and has since the day after the app
-- shipped. The spaces made in that first day never got one, so a board that has been
-- in use the longest is the one board missing the column for work that is parked -
-- and the only way to get it back was to type it in by hand, in every space, which is
-- the opposite of what a default is for.
--
-- Same rules as the Blocked backfill before it. Nothing is duplicated: a space that
-- already calls a stage "On hold" keeps its own and is skipped, case-folded, because
-- "On Hold" and "on hold" are the same stage to whoever typed one. Nothing already
-- there is renamed, recoloured, reordered or reassigned a kind.
--
-- The kind is `open` rather than `active`: a parked task is not being worked on, and
-- every count of what is in progress reads the kind rather than the name.

-- gen_random_uuid() is built in on PG 13+ but lives in pgcrypto on older instances.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Where today's defaults have it: just past Blocked, which is itself just past the
-- first stage that means work is under way. A space with no blocked stage falls back
-- to that active stage, then to the end of everything unfinished, so it still lands
-- before Done and Cancelled rather than off the right edge of the board. The gap
-- between stages is 1024 and the column is a float, so +1 slots into it without
-- renumbering anything a team dragged into place.
INSERT INTO "TaskStatus" ("id", "spaceId", "name", "type", "color", "order")
SELECT
    gen_random_uuid(),
    s."id",
    'On hold',
    'open',
    '#92400e',
    COALESCE(
        (
            SELECT MAX(t."order")
            FROM "TaskStatus" t
            WHERE t."spaceId" = s."id" AND t."type" = 'blocked'
        ),
        (
            SELECT MIN(t."order")
            FROM "TaskStatus" t
            WHERE t."spaceId" = s."id" AND t."type" = 'active'
        ),
        (
            SELECT MAX(t."order")
            FROM "TaskStatus" t
            WHERE t."spaceId" = s."id" AND t."type" IN ('open', 'active')
        ),
        (SELECT MAX(t."order") FROM "TaskStatus" t WHERE t."spaceId" = s."id"),
        0
    ) + 1
FROM "TaskSpace" s
WHERE NOT EXISTS (
    SELECT 1 FROM "TaskStatus" t WHERE t."spaceId" = s."id" AND lower(t."name") = 'on hold'
);
