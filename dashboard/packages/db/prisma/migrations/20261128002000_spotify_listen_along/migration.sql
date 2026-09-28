-- Listening along with somebody's Spotify: one row per listener, naming whose
-- music they follow. Nobody is following anybody until they press the button,
-- so this migration changes nothing for anybody.
CREATE TABLE IF NOT EXISTS "SpotifyListenAlong" (
    "listenerId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "trackId" TEXT NOT NULL DEFAULT '',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpotifyListenAlong_pkey" PRIMARY KEY ("listenerId")
);

CREATE INDEX IF NOT EXISTS "SpotifyListenAlong_hostId_idx" ON "SpotifyListenAlong"("hostId");

ALTER TABLE "SpotifyListenAlong" DROP CONSTRAINT IF EXISTS "SpotifyListenAlong_listenerId_fkey";
ALTER TABLE "SpotifyListenAlong" ADD CONSTRAINT "SpotifyListenAlong_listenerId_fkey" FOREIGN KEY ("listenerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SpotifyListenAlong" DROP CONSTRAINT IF EXISTS "SpotifyListenAlong_hostId_fkey";
ALTER TABLE "SpotifyListenAlong" ADD CONSTRAINT "SpotifyListenAlong_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
