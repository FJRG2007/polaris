-- Who may report into a telemetry project, and the number that names it.
--
-- Two things: the rules a report is admitted by (where from, what with, and
-- optionally a key it has to carry), and the counters that say what was turned
-- away - because a project refusing everything and a project nobody is reporting
-- to look identical from the screen otherwise.
--
-- Re-runnable, like every migration here: applied twice it does nothing the
-- second time.

-- AlterTable
ALTER TABLE "TelemetryProject" ADD COLUMN IF NOT EXISTS "reporters" TEXT NOT NULL DEFAULT 'internal',
ADD COLUMN IF NOT EXISTS "allowedCidrs" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN IF NOT EXISTS "allowedUserAgents" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN IF NOT EXISTS "deniedUserAgents" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN IF NOT EXISTS "requireSecret" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "secretHash" TEXT,
ADD COLUMN IF NOT EXISTS "secretTail" TEXT,
ADD COLUMN IF NOT EXISTS "refusedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "refusedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "refusedIp" TEXT,
ADD COLUMN IF NOT EXISTS "refusedAgent" TEXT,
ADD COLUMN IF NOT EXISTS "refusedReason" TEXT;

-- A project number that was counted up gets a random one instead.
--
-- The number is the last segment of a DSN, so a sequence there says how many
-- projects an instance has and makes the next one guessable. Only the low
-- numbers a counter would have produced are touched, which is what makes this
-- safe to run again: a number already drawn at random is left where it is, and
-- so is the DSN that carries it.
DO $$
DECLARE
    project RECORD;
    candidate INTEGER;
    tries INTEGER;
BEGIN
    FOR project IN SELECT "id" FROM "TelemetryProject" WHERE "number" < 100000000 LOOP
        tries := 0;
        LOOP
            candidate := 100000000 + floor(random() * 2000000000)::INTEGER;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM "TelemetryProject" WHERE "number" = candidate);
            tries := tries + 1;
            EXIT WHEN tries > 50;
        END LOOP;
        IF tries <= 50 THEN
            UPDATE "TelemetryProject" SET "number" = candidate WHERE "id" = project."id";
        END IF;
    END LOOP;
END $$;
