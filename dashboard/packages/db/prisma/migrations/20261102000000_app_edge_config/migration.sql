-- What the edge does in front of a service beyond routing to it, and whether the
-- service is reachable on the host's own interfaces at all.
--
-- `publishPort` defaults to true so every service that exists keeps answering on
-- the machine's IP and port exactly as before; only services made after this start
-- with it off. `edgeConfig` defaults to the empty object, which asks for nothing.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "edgeConfig" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "publishPort" BOOLEAN NOT NULL DEFAULT true;
