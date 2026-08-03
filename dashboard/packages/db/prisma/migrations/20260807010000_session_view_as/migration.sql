-- An administrator looking at Polaris as somebody else, recorded against their
-- own session rather than as a session of the account being looked at: the point
-- is that the other account is not signed in anywhere new, so nothing shows up on
-- its devices list and nothing outlives the administrator's own sign-out.
--
-- Exactly one of the two is ever set. viewAsUserId is another account this
-- session acts as; viewAsRoleId is a role whose grants stand in for the
-- administrator's own so they can see what that role sees. viewAsAt is the start,
-- which is what lets the pretence lapse on its own if it is forgotten.
ALTER TABLE "SessionState" ADD COLUMN "viewAsUserId" UUID;
ALTER TABLE "SessionState" ADD COLUMN "viewAsRoleId" UUID;
ALTER TABLE "SessionState" ADD COLUMN "viewAsAt" TIMESTAMP(3);
