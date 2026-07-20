-- CreateTable
CREATE TABLE "DeployTarget" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'local',
    "hostId" UUID,
    "runtime" TEXT NOT NULL DEFAULT 'compose',
    "proxyNetwork" TEXT NOT NULL DEFAULT 'polaris-proxy',
    "lastAppliedHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeployTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Environment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceConfig" TEXT NOT NULL DEFAULT '{}',
    "buildConfig" TEXT NOT NULL DEFAULT '{}',
    "healthcheck" TEXT,
    "desiredState" TEXT NOT NULL DEFAULT 'running',
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "currentDeploymentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedDatabase" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "volumeName" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "exposePort" INTEGER,
    "encryptedCredential" BYTEA,
    "credentialNonce" BYTEA,
    "credentialKeyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedDatabase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "deployableType" TEXT NOT NULL,
    "deployableId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "imageTag" TEXT,
    "commitSha" TEXT,
    "logPath" TEXT,
    "triggeredById" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'auto',
    "targetPort" INTEGER NOT NULL,
    "https" BOOLEAN NOT NULL DEFAULT true,
    "certResolver" TEXT NOT NULL DEFAULT 'le',
    "pathPrefix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvVar" (
    "id" UUID NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "value" TEXT,
    "encryptedValue" BYTEA,
    "valueNonce" BYTEA,
    "valueKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvVar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Volume" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "applicationId" UUID,
    "name" TEXT NOT NULL,
    "mountPath" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'volume',
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Volume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeployTicket" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "containerRef" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'terminal',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeployTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeployTarget_ownerId_name_key" ON "DeployTarget"("ownerId", "name");
CREATE INDEX "DeployTarget_ownerId_idx" ON "DeployTarget"("ownerId");
CREATE INDEX "DeployTarget_hostId_idx" ON "DeployTarget"("hostId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_ownerId_slug_key" ON "Project"("ownerId", "slug");
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_projectId_slug_key" ON "Environment"("projectId", "slug");
CREATE INDEX "Environment_projectId_idx" ON "Environment"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_environmentId_slug_key" ON "Application"("environmentId", "slug");
CREATE INDEX "Application_targetId_idx" ON "Application"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDatabase_environmentId_slug_key" ON "ManagedDatabase"("environmentId", "slug");
CREATE INDEX "ManagedDatabase_targetId_idx" ON "ManagedDatabase"("targetId");

-- CreateIndex
CREATE INDEX "Deployment_deployableType_deployableId_idx" ON "Deployment"("deployableType", "deployableId");
CREATE INDEX "Deployment_targetId_idx" ON "Deployment"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");
CREATE INDEX "Domain_applicationId_idx" ON "Domain"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvVar_scopeType_scopeId_key_key" ON "EnvVar"("scopeType", "scopeId", "key");
CREATE INDEX "EnvVar_scopeType_scopeId_idx" ON "EnvVar"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "Volume_applicationId_idx" ON "Volume"("applicationId");
CREATE INDEX "Volume_targetId_idx" ON "Volume"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "DeployTicket_tokenHash_key" ON "DeployTicket"("tokenHash");
CREATE INDEX "DeployTicket_userId_idx" ON "DeployTicket"("userId");

-- AddForeignKey
ALTER TABLE "DeployTarget" ADD CONSTRAINT "DeployTarget_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeployTarget" ADD CONSTRAINT "DeployTarget_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Environment" ADD CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Application" ADD CONSTRAINT "Application_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedDatabase" ADD CONSTRAINT "ManagedDatabase_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagedDatabase" ADD CONSTRAINT "ManagedDatabase_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeployTicket" ADD CONSTRAINT "DeployTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
