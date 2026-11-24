-- Which store game a game is, found by its name for games reported with no store
-- id the server asks. A new table; nothing existing changes.
CREATE TABLE IF NOT EXISTS "GameArtName" (
    "name" TEXT NOT NULL,
    "ref" TEXT,
    "source" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameArtName_pkey" PRIMARY KEY ("name")
);

CREATE INDEX IF NOT EXISTS "GameArtName_checkedAt_idx" ON "GameArtName"("checkedAt");
