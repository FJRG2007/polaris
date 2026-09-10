-- A keyed signature on each retention checkpoint, so verification only starts
-- the audit chain from a cut Polaris made. Null on every checkpoint written
-- before this; the sealing pass signs those once.
ALTER TABLE "AuditCheckpoint" ADD COLUMN IF NOT EXISTS "signature" TEXT;
