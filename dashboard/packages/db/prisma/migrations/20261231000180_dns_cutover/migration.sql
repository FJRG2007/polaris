-- DNS cutovers: moving a hostname from one service to another. Additive.
CREATE TABLE IF NOT EXISTS "DnsCutover" (
    "id" UUID NOT NULL,
    "domainId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "sourceApplicationId" UUID NOT NULL,
    "targetApplicationId" UUID NOT NULL,
    "actorId" UUID,
    "openKey" TEXT,
    "phase" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "oldValues" TEXT NOT NULL DEFAULT '[]',
    "newValue" TEXT,
    "oldTtl" INTEGER,
    "zoneId" TEXT,
    "recordIds" TEXT NOT NULL DEFAULT '[]',
    "checks" TEXT NOT NULL DEFAULT '{}',
    "failure" TEXT,
    "passes" INTEGER NOT NULL DEFAULT 0,
    "lowerUntil" TIMESTAMP(3),
    "switchedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DnsCutover_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DnsCutover_openKey_key" ON "DnsCutover"("openKey");
CREATE INDEX IF NOT EXISTS "DnsCutover_domainId_createdAt_idx" ON "DnsCutover"("domainId", "createdAt");
CREATE INDEX IF NOT EXISTS "DnsCutover_phase_idx" ON "DnsCutover"("phase");

ALTER TABLE "DnsCutover" DROP CONSTRAINT IF EXISTS "DnsCutover_domainId_fkey";
ALTER TABLE "DnsCutover" ADD CONSTRAINT "DnsCutover_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
