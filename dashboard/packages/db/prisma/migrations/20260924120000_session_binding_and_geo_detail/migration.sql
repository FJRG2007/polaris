-- Tying a session to the device and the address it was opened on, and being able
-- to describe whoever turned up with it.
--
-- A session cookie is a bearer token: whoever holds it is the account, wherever
-- they are and whatever they are running. That is the whole of the risk, and
-- nothing here was answering it - a cookie lifted off a phone worked from a
-- desktop in another country, and the owner was never told.
--
-- Two bindings, and they are deliberately different in strength and in default.
--
-- The client binding is on for everybody. A session records the browser and the
-- system it was opened in, and stops working in a different one. Nothing
-- legitimate crosses that line: an update changes a version, not the name of the
-- browser or of the system under it, which is why only names are ever compared.
--
-- The address binding is off by default and is scoped by what kind of device the
-- session is on, because it is the one that can be wrong. A phone changes address
-- several times an hour moving between cell and wifi; a laptop at a desk does
-- not. "desktop" is the setting that is nearly always right, and one session can
-- override the account's rule either way.
--
-- The geo columns are not for either decision - access rules are judged per
-- country and per continent, which was already stored. They are for the report
-- the owner is handed when a session of theirs was used from somewhere it should
-- not have been. "Spain" is not something anybody can take to the police; a city,
-- a network operator, and the hour it happened in the local time of wherever they
-- were standing, are.

-- AlterTable
ALTER TABLE "UserSecurity" ADD COLUMN     "bindSessionsToClient" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pinSessionsToAddress" TEXT NOT NULL DEFAULT 'off';

-- AlterTable
ALTER TABLE "SessionState" ADD COLUMN     "pinToAddress" BOOLEAN;

-- AlterTable
ALTER TABLE "GeoIpCache" ADD COLUMN     "city" TEXT,
ADD COLUMN     "network" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "timeZone" TEXT;

