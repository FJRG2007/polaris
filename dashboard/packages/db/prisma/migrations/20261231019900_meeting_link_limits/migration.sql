-- A meeting's guest link takes the password and address rules every public
-- link offers. Its expiry and cap stay what they were: the link dies with the
-- call. Nullable or an empty list is no restriction, so every existing link
-- keeps opening for whoever holds it. Reversible: drop the four columns.
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "linkPasswordHash" TEXT;
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "allowedCidrs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "allowedContinents" TEXT NOT NULL DEFAULT '[]';
