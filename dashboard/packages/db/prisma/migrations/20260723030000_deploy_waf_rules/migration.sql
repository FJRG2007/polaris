-- Web Application Firewall rules for Deploy. Polymorphic (no FK) scoping like
-- EnvVar so one table covers global, project, environment, and application scope.
CREATE TABLE "WafRule" (
    "id" UUID NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "ipAllowlist" TEXT NOT NULL DEFAULT '[]',
    "ipDenylist" TEXT NOT NULL DEFAULT '[]',
    "requireLogin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WafRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WafRule_scopeType_scopeId_key" ON "WafRule"("scopeType", "scopeId");
CREATE INDEX "WafRule_scopeType_scopeId_idx" ON "WafRule"("scopeType", "scopeId");
