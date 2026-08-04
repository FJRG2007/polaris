-- Which device let a session in.
--
-- Two sign-ins on this account are not answered by the person signing in: one that
-- waits for approval on Account > Sessions, and one that is let through by scanning
-- the code on its sign-in screen. Both were recorded as "somebody approved it" with
-- no way back to which device did, which is the fact that matters when the answer
-- turns out to have been given by a device the owner does not have any more.
--
-- The label is kept beside the id because the authorizing session can be signed out,
-- and there is no foreign key for the same reason: ending a session must not erase
-- what was let in from it.
ALTER TABLE "SessionState" ADD COLUMN "authorizedBySessionId" UUID;
ALTER TABLE "SessionState" ADD COLUMN "authorizedByDevice" TEXT;

-- The scan happens on one device and the session it opens is written by another, on
-- a later request, so the answer waits here in between - beside the sign-in note it
-- belongs to, cleared by the same session that collects that.
ALTER TABLE "UserSecurity" ADD COLUMN "pendingAuthorizerId" UUID;
ALTER TABLE "UserSecurity" ADD COLUMN "pendingAuthorizerDevice" TEXT;
