-- A game's picture, fetched by the server from the store that sells it and kept
-- for everybody here, and which store game a program is, as desktop apps that
-- know it have said. Both are new tables; nothing existing changes.
CREATE TABLE IF NOT EXISTS "GameArt" (
    "ref" TEXT NOT NULL,
    "image" BYTEA,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameArt_pkey" PRIMARY KEY ("ref")
);

CREATE TABLE IF NOT EXISTS "GameArtKey" (
    "key" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameArtKey_pkey" PRIMARY KEY ("key")
);
