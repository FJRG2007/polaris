-- Sign the agent in with nothing, and let the machine's own login answer.
--
-- Distinct from a null `accountId`, which means "whichever of my stored
-- credentials resolves". This means "none of them": the machine is already
-- signed in, in the home that outlives the session, and injecting a stored
-- token over that is how a credential revoked months ago comes to beat a login
-- that works.
--
-- Widening only: every existing row keeps resolving a credential as it did.
ALTER TABLE "AgentSession" ADD COLUMN "useMachineLogin" BOOLEAN NOT NULL DEFAULT false;
