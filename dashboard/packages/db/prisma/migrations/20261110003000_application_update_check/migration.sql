-- What the updates scan last found for a service's live release: a newer image
-- behind its tag, or commits on its branch. Null until the first scan.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "updateCheck" TEXT;
