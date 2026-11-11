-- Custom Polar agents (GPTs-style), and the agent a chat was started with.
-- AlterTable
ALTER TABLE "PolarThread" ADD COLUMN IF NOT EXISTS "agentId" UUID;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PolarAgent" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "web" BOOLEAN NOT NULL DEFAULT true,
    "choice" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PolarAgent_ownerId_name_key" ON "PolarAgent"("ownerId", "name");

-- AddForeignKey
ALTER TABLE "PolarThread" DROP CONSTRAINT IF EXISTS "PolarThread_agentId_fkey";
ALTER TABLE "PolarThread" ADD CONSTRAINT "PolarThread_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "PolarAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolarAgent" DROP CONSTRAINT IF EXISTS "PolarAgent_ownerId_fkey";
ALTER TABLE "PolarAgent" ADD CONSTRAINT "PolarAgent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
