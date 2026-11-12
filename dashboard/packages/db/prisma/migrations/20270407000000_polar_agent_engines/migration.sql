-- Agents pick what does the work (Polar or a coding tool), the account it
-- signs in with and the models it may use. Additive: every existing agent
-- keeps answering on Polar with the model it had.
-- AlterTable
ALTER TABLE "PolarAgent" ADD COLUMN IF NOT EXISTS "account" TEXT,
ADD COLUMN IF NOT EXISTS "engine" TEXT NOT NULL DEFAULT 'polar',
ADD COLUMN IF NOT EXISTS "modelPolicy" TEXT NOT NULL DEFAULT 'preferred',
ADD COLUMN IF NOT EXISTS "models" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PolarAgentDefault" (
    "userId" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "account" TEXT,
    "models" JSONB,
    "modelPolicy" TEXT NOT NULL DEFAULT 'preferred',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarAgentDefault_pkey" PRIMARY KEY ("userId","engine")
);

-- AddForeignKey
ALTER TABLE "PolarAgentDefault" DROP CONSTRAINT IF EXISTS "PolarAgentDefault_userId_fkey";
ALTER TABLE "PolarAgentDefault" ADD CONSTRAINT "PolarAgentDefault_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

