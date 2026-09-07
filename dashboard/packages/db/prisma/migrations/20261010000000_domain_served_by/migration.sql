-- Who answers a hostname: the machine the service runs on, or this instance.
--
-- "server" for everything that exists, which is what every domain already meant:
-- a local app is served by the box Polaris runs on, and a remote app is served by
-- its own server's edge. Nothing changes for anybody until somebody chooses
-- otherwise on a service that runs somewhere else.
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "servedBy" TEXT NOT NULL DEFAULT 'server';
