-- Polar's own "/" commands: a shortcut, the prompt it sends and the model it
-- runs on, per person. A new table only; nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "PolarCommand" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "shortcut" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "choice" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarCommand_userId_shortcut_key" ON "PolarCommand"("userId", "shortcut");

ALTER TABLE "PolarCommand" DROP CONSTRAINT IF EXISTS "PolarCommand_userId_fkey";
ALTER TABLE "PolarCommand" ADD CONSTRAINT "PolarCommand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
