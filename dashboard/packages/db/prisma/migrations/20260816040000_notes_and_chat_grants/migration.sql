-- Give the seeded roles the two permissions that did not exist when they were
-- written.
--
-- Notes used to need nothing but an account and now needs `notes.use`, so an
-- instance that upgrades without this finds every non-admin locked out of notes
-- they already wrote. Seeding cannot fix it: it never rewrites a role that is
-- already there, which is the promise that lets an operator edit one.
--
-- Only the two system roles the defaults grant these to, and only where they are
-- missing, so a role an operator has narrowed on purpose keeps everything else
-- it says.

UPDATE "Role"
SET "permissions" = (
        ("permissions"::jsonb) || (
            SELECT COALESCE(jsonb_agg(candidate.grant_key), '[]'::jsonb)
            FROM (VALUES ('notes.use'::text), ('chat.use'::text)) AS candidate(grant_key)
            WHERE NOT (("permissions"::jsonb) @> to_jsonb(candidate.grant_key))
        )
    )::text
WHERE "isSystem" = true
  AND "name" IN ('member', 'viewer')
  AND jsonb_typeof("permissions"::jsonb) = 'array'
  AND NOT (("permissions"::jsonb) @> '["notes.use", "chat.use"]'::jsonb);
