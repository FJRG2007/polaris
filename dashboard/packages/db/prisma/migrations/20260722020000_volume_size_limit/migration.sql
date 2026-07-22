-- Optional configurable size cap on a deploy volume (human-readable, e.g. "10G").
ALTER TABLE "Volume" ADD COLUMN "sizeLimit" TEXT;
