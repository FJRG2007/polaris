-- Per-account display choices (temperature unit, date order, year width, clock,
-- currency, language) as stringified JSON. Only the fields the account chose are
-- stored; the rest follow the platform default in Setting."display.defaults".
ALTER TABLE "User" ADD COLUMN "displayPrefs" TEXT;
