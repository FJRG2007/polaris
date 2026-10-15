-- SFTP accounts per deployed service, and the on-demand server that answers
-- them. Additive only. To reverse, drop the two tables.

CREATE TABLE IF NOT EXISTS "FileAccessAccount" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "passwordCipher" BYTEA,
    "passwordNonce" BYTEA,
    "passwordKeyId" TEXT,
    "publicKey" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileAccessAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FileAccessAccount_applicationId_username_key" ON "FileAccessAccount"("applicationId", "username");

CREATE TABLE IF NOT EXISTS "FileAccessServer" (
    "applicationId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "port" INTEGER NOT NULL,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FileAccessServer_pkey" PRIMARY KEY ("applicationId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FileAccessServer_targetId_port_key" ON "FileAccessServer"("targetId", "port");

DO $$ BEGIN
    ALTER TABLE "FileAccessAccount" ADD CONSTRAINT "FileAccessAccount_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "FileAccessServer" ADD CONSTRAINT "FileAccessServer_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
