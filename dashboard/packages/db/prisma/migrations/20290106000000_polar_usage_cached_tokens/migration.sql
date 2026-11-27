-- Input a provider read from its prompt cache, per Polar answer, so the Usage
-- page can show cached tokens beside input and output the way the provider
-- consoles do.
--
-- Additive: rows before it read 0, which is what they recorded (nothing).
ALTER TABLE "PolarUsage" ADD COLUMN IF NOT EXISTS "cachedTokens" INTEGER NOT NULL DEFAULT 0;
