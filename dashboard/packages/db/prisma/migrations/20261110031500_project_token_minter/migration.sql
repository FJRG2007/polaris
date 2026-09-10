-- A project token acts as the person who minted it, not as the project's owner.
--
-- Tokens minted before this were issued against the owner's account whoever
-- made them, so a member limited to one environment, or without the right to
-- read variables, held a token with the owner's full reach. Each one is handed
-- to its minter as recorded in the audit log when the token was made - the
-- entry names the key by its prefix - so from here it carries that person's
-- access and no more. A token with no such entry keeps acting as the owner, which
-- is what it has always done.
--
-- Rerunnable: a second run finds every token already on its minter and changes
-- nothing.
UPDATE "ApiKey" AS k
SET "userId" = a."actorId"
FROM "AuditLog" AS a
WHERE k."projectId" IS NOT NULL
  AND a."action" = 'deploy.project.token.create'
  AND a."targetId" = k."projectId"
  AND a."actorId" IS NOT NULL
  AND a."actorId" <> k."userId"
  AND a."metadata" IS NOT NULL
  AND strpos(a."metadata", '"prefix":"' || k."prefix" || '"') > 0
  AND EXISTS (SELECT 1 FROM "User" AS u WHERE u."id" = a."actorId");
