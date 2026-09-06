-- Who may ring an account.
--
-- Friends by default, which is the same answer the transfer setting beside it
-- takes and for the same reason: a call is the loudest thing one account can do
-- to another. Existing rows take the default, so nobody's answer changes except
-- from "anybody could" to "the people you know can", which is the direction a
-- privacy setting is allowed to move on its own.
ALTER TABLE "UserPrivacy" ADD COLUMN "calls" TEXT NOT NULL DEFAULT 'friends';
