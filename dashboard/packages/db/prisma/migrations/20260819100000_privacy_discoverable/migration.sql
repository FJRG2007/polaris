-- Whether an account turns up when somebody searches for people.
--
-- Existing accounts keep the behaviour they have had until now, which is to be
-- findable: making everybody invisible on an upgrade would look exactly like
-- half the directory being deleted.
ALTER TABLE "UserPrivacy" ADD COLUMN "discoverable" TEXT NOT NULL DEFAULT 'everyone';
