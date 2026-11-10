-- Tasks hands a space or a folder over the way everything else in Polaris is
-- handed over: one AccessGrant per person or team, written and removed by the
-- share dialog. Every membership written by the older Tasks-only tables is
-- copied across here with the role it carried as the capability, so nobody
-- loses a space they could open yesterday. The old tables and their rows stay
-- where they are (nothing is dropped) but are no longer read, which is what
-- lets removing somebody in the share dialog actually take their access away.
--
-- Shaped like a grant the share dialog writes: no dates, every day, no limit
-- on uses, no actions listed (everything the capability reaches), no note.
-- grantedById is left empty because the old rows never recorded who invited.
-- Each statement skips a pair that already holds a grant on the same subject,
-- so running this again, or after somebody was shared by hand, adds nothing.

-- People on a whole space.
INSERT INTO "AccessGrant" ("id", "subjectType", "subjectId", "principalType", "principalId", "capability", "actions", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'task.space', o."spaceId", 'user', o."userId", o."role", ARRAY[]::TEXT[], o."createdAt", CURRENT_TIMESTAMP
FROM "TaskSpaceMember" o
WHERE NOT EXISTS (
    SELECT 1 FROM "AccessGrant" g
    WHERE g."subjectType" = 'task.space'
      AND g."subjectId" = o."spaceId"
      AND g."principalType" = 'user'
      AND g."principalId" = o."userId"
  )
  AND o."role" IN ('guest', 'member', 'admin');

-- People on one branch of a space.
INSERT INTO "AccessGrant" ("id", "subjectType", "subjectId", "principalType", "principalId", "capability", "actions", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'task.folder', o."folderId", 'user', o."userId", o."role", ARRAY[]::TEXT[], o."createdAt", CURRENT_TIMESTAMP
FROM "TaskFolderMember" o
WHERE NOT EXISTS (
    SELECT 1 FROM "AccessGrant" g
    WHERE g."subjectType" = 'task.folder'
      AND g."subjectId" = o."folderId"
      AND g."principalType" = 'user'
      AND g."principalId" = o."userId"
  )
  AND o."role" IN ('guest', 'member', 'admin');

-- Teams on a whole space.
INSERT INTO "AccessGrant" ("id", "subjectType", "subjectId", "principalType", "principalId", "capability", "actions", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'task.space', o."spaceId", 'team', o."teamId", o."role", ARRAY[]::TEXT[], o."createdAt", CURRENT_TIMESTAMP
FROM "TaskSpaceTeam" o
WHERE NOT EXISTS (
    SELECT 1 FROM "AccessGrant" g
    WHERE g."subjectType" = 'task.space'
      AND g."subjectId" = o."spaceId"
      AND g."principalType" = 'team'
      AND g."principalId" = o."teamId"
  )
  AND o."role" IN ('guest', 'member', 'admin');

-- Teams on one branch of a space.
INSERT INTO "AccessGrant" ("id", "subjectType", "subjectId", "principalType", "principalId", "capability", "actions", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'task.folder', o."folderId", 'team', o."teamId", o."role", ARRAY[]::TEXT[], o."createdAt", CURRENT_TIMESTAMP
FROM "TaskFolderTeam" o
WHERE NOT EXISTS (
    SELECT 1 FROM "AccessGrant" g
    WHERE g."subjectType" = 'task.folder'
      AND g."subjectId" = o."folderId"
      AND g."principalType" = 'team'
      AND g."principalId" = o."teamId"
  )
  AND o."role" IN ('guest', 'member', 'admin');
