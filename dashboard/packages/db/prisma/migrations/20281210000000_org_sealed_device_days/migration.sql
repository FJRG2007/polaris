-- An organization may shorten how long a sealed-chat device of its people goes
-- unused before it leaves their conversations.
--
-- The instance already has the limit (a setting, 30 days by default, 7 to 90).
-- An organization can only tighten it: an account in several organizations gets
-- the strictest of the instance's and theirs. Null is the instance's limit, which
-- is what every organization that already exists keeps.

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "sealedDeviceDays" INTEGER;
