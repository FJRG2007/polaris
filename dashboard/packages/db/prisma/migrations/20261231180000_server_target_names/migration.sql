-- A server's deploy target kept the name the server had when it was adopted, so
-- a later rename never reached the screens that read the target.
UPDATE "DeployTarget" AS target
SET "name" = host."name"
FROM "Host" AS host
WHERE target."hostId" = host."id"
  AND target."kind" = 'host'
  AND target."name" <> host."name";
