-- The repository a Code task asked Polar about, so the conversation reopens in
-- Code with it. One nullable column; nothing existing changes.
--
-- Running it a second time is a no-op.
ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "code" JSONB;
