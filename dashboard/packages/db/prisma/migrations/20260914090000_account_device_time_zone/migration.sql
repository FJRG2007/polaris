-- What "automatic" resolves to for an account where there is no browser to ask.
--
-- A status schedule is a wall-clock rule read against the account's own clock,
-- and almost every account's clock is "automatic" - the device's. The server has
-- no device, so it read those windows on the deployment's zone: a window written
-- as 00:00 to 09:00 by somebody two hours east opened at two in the morning for
-- them, while the screen that draws it said "running now" because a browser did
-- have an answer. Same rule, two clocks.
--
-- Reported by the dashboard rather than chosen. Null until a browser has said.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deviceTimeZone" TEXT;
