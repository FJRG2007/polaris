-- The models each coding tool reported on a session's machine, per person and
-- tool (lib/agents/native-models.ts). Additive and rerunnable.
CREATE TABLE IF NOT EXISTS "AgentNativeModels" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cli" TEXT NOT NULL,
    "models" TEXT NOT NULL DEFAULT '[]',
    "fetchedAt" TIMESTAMP(3),
    "error" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentNativeModels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AgentNativeModels_userId_cli_key" ON "AgentNativeModels"("userId", "cli");
ALTER TABLE "AgentNativeModels" DROP CONSTRAINT IF EXISTS "AgentNativeModels_userId_fkey";
ALTER TABLE "AgentNativeModels" ADD CONSTRAINT "AgentNativeModels_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
