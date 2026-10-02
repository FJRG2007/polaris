-- A port per domain.
--
-- `Domain.portPinned` marks a target port somebody chose for that one address -
-- a second port of the same service on a name of its own. Every row that exists
-- already is false, so nothing an install routes today changes: an unpinned
-- domain keeps following the service's own port as it always has.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "portPinned" BOOLEAN NOT NULL DEFAULT false;
