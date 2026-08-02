-- The address a session was opened on.
--
-- A deployment answers on more than one name (polaris.local on the LAN, its
-- domain from outside) and the session cookie is host-only, so signing in on
-- both leaves two sessions that look identical in every column that exists.
-- Recording the host is what lets a person - and an administrator looking at
-- somebody else's account - tell them apart.
--
-- Nullable with no backfill: sessions opened before this ran did not record it,
-- and guessing which name they came in on would be worse than saying nothing.
-- They adopt the column on their next request.

ALTER TABLE "SessionState" ADD COLUMN "host" TEXT;
