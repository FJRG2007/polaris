-- The browser a passkey was registered from.
--
-- A passkey row says which address it works on and what the person called it,
-- and nothing about the device holding it. So the account could list its
-- passkeys and list its remembered devices, but never say that this laptop is
-- the one holding that credential - which is the first thing somebody wants
-- when a device is out of their hands and they are deciding what to take away
-- from it.
--
-- Recorded off the registration ceremony as it goes past, from the same header
-- a session's user-agent comes from, and read the same way: a client-supplied
-- label that groups a device's things together and never decides anything.
--
-- Nullable with no backfill: nothing recorded it before this ran, and guessing
-- which browser created a credential would be worse than saying nothing.

ALTER TABLE "Passkey" ADD COLUMN "userAgent" TEXT;
