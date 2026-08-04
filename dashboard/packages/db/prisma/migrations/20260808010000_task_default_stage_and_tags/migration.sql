-- Every space now starts with a Blocked stage and the bug/vulnerability/security
-- labels. A space created before today never got them, and the point of a default is
-- that nobody has to go and make it, so the spaces already here are given the same.
--
-- Nothing is duplicated: a space that already calls something "Blocked", or already
-- has a "bug" label, keeps its own and is skipped. The comparison is case-folded on
-- purpose, because "Bug" and "bug" are the same label to the person who made one and
-- the unique index would let both exist side by side.
--
-- Nothing is renamed, recoloured or reordered either. What a team called their own
-- stage is theirs, and a migration that "corrects" it is a migration that turns up in
-- a support message.

-- gen_random_uuid() is built in on PG 13+ but lives in pgcrypto on older instances.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Blocked lands just past the last stage that is not finished work, so it sits at the
-- end of what is still in flight and before Done and Cancelled - not off the right
-- edge of the board. The gap between stages is 1024, so +1 slots into it without
-- renumbering anything, and a space whose stages were all dragged about still gets a
-- key that sorts where it should.
INSERT INTO "TaskStatus" ("id", "spaceId", "name", "type", "color", "order")
SELECT
    gen_random_uuid(),
    s."id",
    'Blocked',
    'open',
    '#ef4444',
    COALESCE(
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
    SELECT 1 FROM "TaskStatus" t WHERE t."spaceId" = s."id" AND lower(t."name") = 'blocked'
);

INSERT INTO "TaskTag" ("id", "spaceId", "name", "color")
SELECT gen_random_uuid(), s."id", d."name", d."color"
FROM "TaskSpace" s
CROSS JOIN (
    VALUES ('bug', '#ef4444'), ('vulnerability', '#f97316'), ('security', '#6366f1')
) AS d("name", "color")
WHERE NOT EXISTS (
    SELECT 1 FROM "TaskTag" t WHERE t."spaceId" = s."id" AND lower(t."name") = lower(d."name")
);
