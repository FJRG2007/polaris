-- Polar's chat commands (/clear, /compact, /context, /usage, /rename, /export,
-- /branch, /temp, /memory, /help) run before a person's own command of the same
-- name, which the command form now refuses. A command someone already saved
-- under one of those names is renamed to "my-<name>" (with its id's first eight
-- characters when that name is taken too), so it keeps working and can still be
-- edited. Only the shortcut changes; the prompt and model stay as they were.
--
-- A second run finds no command under those names and changes nothing.
UPDATE "PolarCommand" AS command
SET "shortcut" = CASE
    WHEN EXISTS (
        SELECT 1 FROM "PolarCommand" AS other
        WHERE other."userId" = command."userId"
          AND other."shortcut" = 'my-' || command."shortcut"
    )
    THEN 'my-' || command."shortcut" || '-' || left(command."id"::text, 8)
    ELSE 'my-' || command."shortcut"
END
WHERE command."shortcut" IN (
    'clear', 'compact', 'context', 'usage', 'rename',
    'export', 'branch', 'temp', 'memory', 'help'
);
