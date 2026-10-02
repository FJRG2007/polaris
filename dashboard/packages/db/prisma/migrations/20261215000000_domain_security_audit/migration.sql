-- One row per domain Polaris audits for security: its last report and whether
-- the operator handed its safe fixes to Polaris, and under whose token.
CREATE TABLE IF NOT EXISTS "DomainSecurityAudit" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "grade" TEXT NOT NULL DEFAULT 'unknown',
    "report" JSONB,
    "checkedAt" TIMESTAMP(3),
    "dedicated" BOOLEAN NOT NULL DEFAULT false,
    "dedicatedBy" UUID,
    "dedicatedScope" TEXT,
    "lastAutoFix" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DomainSecurityAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DomainSecurityAudit_domain_key" ON "DomainSecurityAudit"("domain");
