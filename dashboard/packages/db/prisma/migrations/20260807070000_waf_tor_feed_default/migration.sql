-- Blocking the Tor network is a rule now, and an absent WafIpFeed row reads as ON: a
-- fresh instance refuses exit nodes without anybody having to find the switch first.
--
-- That default must not reach backwards. An instance that has been running has already
-- made its choice by leaving the old switch alone, and turning it on underneath them
-- would be this migration deciding who may reach their services - the kind of change an
-- operator finds out about from a support message. So a database that already holds an
-- account has that choice written down as OFF, which is exactly what it was enforcing
-- yesterday; a database with no accounts has not been set up yet and is left to the
-- default, which is on.
--
-- ON CONFLICT because an operator who did use the old switch already has a row, and
-- theirs is the authoritative answer either way.
INSERT INTO "WafIpFeed" ("id", "entries", "enabled", "updatedAt")
SELECT 'tor', '[]', false, NOW()
WHERE EXISTS (SELECT 1 FROM "User")
ON CONFLICT ("id") DO NOTHING;
