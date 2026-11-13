-- What arrived at each webhook trigger, refused requests included.
CREATE TABLE IF NOT EXISTS "AutomationHookDelivery" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "ip" TEXT,
    "country" TEXT,
    "userAgent" TEXT,
    "status" INTEGER NOT NULL,
    "reason" TEXT,
    "detail" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "AutomationHookDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AutomationHookDelivery" ADD COLUMN IF NOT EXISTS "detail" TEXT;

CREATE INDEX IF NOT EXISTS "AutomationHookDelivery_automationId_nodeId_at_idx" ON "AutomationHookDelivery"("automationId", "nodeId", "at");

DO $$ BEGIN
    ALTER TABLE "AutomationHookDelivery" ADD CONSTRAINT "AutomationHookDelivery_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
