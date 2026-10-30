-- A server's deploy target kept the name the server had when it was adopted, so
-- a later rename never reached the screens that read the target.
--
-- Target names are unique per owner and server names are not, so a target keeps
-- its name when the new one is already held, or when another target of the same
-- owner is taking it here. A refused update would stop the dashboard from booting.
WITH renamed AS (
    SELECT
        target."id",
        host."name",
        ROW_NUMBER() OVER (
            PARTITION BY target."ownerId", host."name"
            ORDER BY target."createdAt", target."id"
        ) AS position
    FROM "DeployTarget" AS target
    JOIN "Host" AS host ON host."id" = target."hostId"
    WHERE target."kind" = 'host'
      AND target."name" <> host."name"
      AND NOT EXISTS (
          SELECT 1
          FROM "DeployTarget" AS other
          WHERE other."ownerId" = target."ownerId"
            AND other."name" = host."name"
      )
)
UPDATE "DeployTarget" AS target
SET "name" = renamed."name"
FROM renamed
WHERE target."id" = renamed."id"
  AND renamed.position = 1;
