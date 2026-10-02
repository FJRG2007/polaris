-- Where a service also runs elsewhere, as its card says it.
--
-- `ExternalService` gains what a service card needs to say where the production
-- copy of a service answers: the Polaris service it is the same thing as (set by
-- hand or by a move), the repository the provider builds (which is how the two
-- are matched when nobody linked them), and the provider's production domains,
-- read on their own slower clock than the release status.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "ExternalService" ADD COLUMN IF NOT EXISTS "applicationId" UUID;
ALTER TABLE "ExternalService" ADD COLUMN IF NOT EXISTS "repo" TEXT;
ALTER TABLE "ExternalService" ADD COLUMN IF NOT EXISTS "productionDomains" TEXT;
ALTER TABLE "ExternalService" ADD COLUMN IF NOT EXISTS "domainsCheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExternalService_applicationId_idx" ON "ExternalService"("applicationId");
