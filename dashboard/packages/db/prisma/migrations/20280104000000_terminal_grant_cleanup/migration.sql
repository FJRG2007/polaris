-- A grant on a Polaris Terminal, and its log, that outlived the terminal: the
-- same cleanup 20270329000000_orphan_cleanup does for the kinds before this one.
-- Signing a terminal out already drops them (lib/access/forget.ts); this covers
-- a row removed any other way. Data only; a second run finds nothing to delete.
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'terminal.instance'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "TerminalInstance" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'terminal.instance'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "TerminalInstance" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
