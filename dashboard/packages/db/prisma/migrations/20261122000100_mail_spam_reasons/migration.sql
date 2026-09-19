-- Everything the junk filter said against a message, strongest first, beside
-- the one line it already kept. A message that was filed away is one whose
-- reader is entitled to the whole case rather than its headline.
--
-- Empty for every existing row: nothing is re-judged, and a message that
-- arrived before this still says exactly what it said.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "MailMessage" ADD COLUMN IF NOT EXISTS "spamReasons" TEXT[];
