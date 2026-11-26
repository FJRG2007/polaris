-- Whether a denied permission request's reason reaches the agent in the turn it
-- is on, so a message sent at an approval is delivered once: as the reason
-- where it is carried, as a new message where it is not.
--
-- Additive: existing rows read as "not carried", so a request open across the
-- update gets the message as a new one rather than losing it.
ALTER TABLE "AgentPermissionRequest" ADD COLUMN IF NOT EXISTS "carriesReason" BOOLEAN NOT NULL DEFAULT false;
