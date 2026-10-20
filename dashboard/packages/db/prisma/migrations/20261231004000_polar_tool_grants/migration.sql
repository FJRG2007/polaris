-- Polar's "Always allow": the tools (or, for a destructive tool, the one target)
-- a person said to stop asking about. A new table only; nothing existing changes.
--
-- Every statement is written so that running it a second time is a no-op.
CREATE TABLE IF NOT EXISTS "PolarToolGrant" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "targetName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarToolGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PolarToolGrant_ownerId_tool_target_key" ON "PolarToolGrant"("ownerId", "tool", "target");

ALTER TABLE "PolarToolGrant" DROP CONSTRAINT IF EXISTS "PolarToolGrant_ownerId_fkey";
ALTER TABLE "PolarToolGrant" ADD CONSTRAINT "PolarToolGrant_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
