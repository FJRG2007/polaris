-- CreateTable
CREATE TABLE "AddressReputation" (
    "ip" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "allow" BOOLEAN NOT NULL,
    "reason" TEXT,
    "rules" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressReputation_pkey" PRIMARY KEY ("ip")
);

-- CreateIndex
CREATE INDEX "AddressReputation_checkedAt_idx" ON "AddressReputation"("checkedAt");
