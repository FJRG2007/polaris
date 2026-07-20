-- CreateTable
CREATE TABLE "Host" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL,
    "hostKey" TEXT,
    "encryptedCredential" BYTEA,
    "credentialNonce" BYTEA,
    "credentialKeyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Host_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Host_ownerId_idx" ON "Host"("ownerId");

-- AddForeignKey
ALTER TABLE "Host" ADD CONSTRAINT "Host_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
