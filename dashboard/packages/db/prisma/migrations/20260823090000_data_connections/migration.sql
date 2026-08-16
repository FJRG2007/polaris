-- CreateTable
CREATE TABLE "DataConnection" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "managedDatabaseId" UUID,
    "host" TEXT,
    "port" INTEGER,
    "database" TEXT,
    "username" TEXT,
    "encryptedCredential" BYTEA,
    "credentialNonce" BYTEA,
    "credentialKeyId" TEXT,
    "tls" BOOLEAN NOT NULL DEFAULT false,
    "readOnly" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataConnection_ownerId_idx" ON "DataConnection"("ownerId");

-- CreateIndex
CREATE INDEX "DataConnection_managedDatabaseId_idx" ON "DataConnection"("managedDatabaseId");

-- AddForeignKey
ALTER TABLE "DataConnection" ADD CONSTRAINT "DataConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataConnection" ADD CONSTRAINT "DataConnection_managedDatabaseId_fkey" FOREIGN KEY ("managedDatabaseId") REFERENCES "ManagedDatabase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
