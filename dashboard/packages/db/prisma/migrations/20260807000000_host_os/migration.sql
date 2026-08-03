-- What each server runs, in the words the machine uses for itself ("Ubuntu 24.04.1
-- LTS", "macOS 15.3"), and when that was last read.
--
-- Kept on the row rather than asked for on every render: the servers list has to
-- paint immediately, and a machine that is unreachable should still say what it is
-- instead of going blank. Both are nullable because every server registered before
-- this has never been asked - they fill in the first time each one is probed.
ALTER TABLE "Host" ADD COLUMN "os" TEXT;
ALTER TABLE "Host" ADD COLUMN "osProbedAt" TIMESTAMP(3);
