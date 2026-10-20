-- What each catalogued model reads (text, image, pdf, ...), so Polar sends a
-- document as a file only to a model that takes one. One added column with a
-- default; existing rows read "unknown" until the next catalogue refresh.
--
-- Running it a second time is a no-op.
ALTER TABLE "AgentModel" ADD COLUMN IF NOT EXISTS "inputModalities" TEXT NOT NULL DEFAULT '[]';
