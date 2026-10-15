-- The first-run setup is offered once, to the first administrator of a new
-- install. A deployment that already has accounts was set up long ago: it is
-- marked as having skipped it, so an update never greets its operator with a
-- first-run screen. It can still be opened from Management.
INSERT INTO "Setting" ("id", "key", "value", "scope")
SELECT gen_random_uuid(), 'setup.wizard', 'skipped', 'global'
WHERE EXISTS (SELECT 1 FROM "User")
ON CONFLICT ("key") DO NOTHING;
