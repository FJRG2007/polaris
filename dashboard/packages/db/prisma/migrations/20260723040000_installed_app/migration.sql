-- Marketplace install records: one row per installed app, linking a catalog
-- manifest (lib/apps/catalog.ts) to the server it runs on and the Deploy
-- Application backing a compose-template install. owner/target/application are
-- bare uuids (no FK), matching the Integration precedent, so installs never
-- couple the shared User/DeployTarget/Application models; cleanup is in app code.
CREATE TABLE "InstalledApp" (
    "id" UUID NOT NULL,
    "catalogId" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "targetId" UUID,
    "applicationId" UUID,
    "config" TEXT NOT NULL DEFAULT '{}',
    "encryptedSecret" BYTEA,
    "secretNonce" BYTEA,
    "secretKeyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'installing',
    "installedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstalledApp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InstalledApp_ownerId_idx" ON "InstalledApp"("ownerId");

CREATE INDEX "InstalledApp_catalogId_idx" ON "InstalledApp"("catalogId");

CREATE INDEX "InstalledApp_targetId_idx" ON "InstalledApp"("targetId");

CREATE INDEX "InstalledApp_applicationId_idx" ON "InstalledApp"("applicationId");
