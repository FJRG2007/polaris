-- Conditional "Sites allowed to embed": framing decided per request at the edge.
ALTER TABLE "WafRule" ADD COLUMN IF NOT EXISTS "frameRules" TEXT NOT NULL DEFAULT '[]';
