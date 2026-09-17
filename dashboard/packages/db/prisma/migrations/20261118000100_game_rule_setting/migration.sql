-- World rules and difficulty as the operator set them from Polaris, applied to
-- the server when it answers.
--
-- Written so that running it a second time is a no-op.

CREATE TABLE IF NOT EXISTS "GameRuleSetting" (
    "id" UUID NOT NULL,
    "installedAppId" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL,
    "setById" UUID,
    "appliedAt" TIMESTAMP(3),
    "failure" TEXT,

    CONSTRAINT "GameRuleSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GameRuleSetting_installedAppId_rule_key" ON "GameRuleSetting"("installedAppId", "rule");
CREATE INDEX IF NOT EXISTS "GameRuleSetting_installedAppId_idx" ON "GameRuleSetting"("installedAppId");
