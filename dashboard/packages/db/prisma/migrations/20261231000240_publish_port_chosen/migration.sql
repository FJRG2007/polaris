-- Whether a service's host port was opened on purpose. Additive; reverting is
-- dropping the column.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "publishPortChosen" BOOLEAN NOT NULL DEFAULT false;

-- A port somebody opened from the service's settings, and left open, was chosen:
-- the last time it was switched, it was switched on.
UPDATE "Application" AS a
SET "publishPortChosen" = true
FROM (
    SELECT DISTINCT ON ("targetId") "targetId", "metadata"
    FROM "AuditLog"
    WHERE "action" = 'deploy.app.publishPort'
      AND "targetId" IS NOT NULL
    ORDER BY "targetId", "at" DESC
) AS last
WHERE a."publishPort" = true
  AND a."id"::text = last."targetId"::text
  AND last."metadata" LIKE '%"publish":true%';
