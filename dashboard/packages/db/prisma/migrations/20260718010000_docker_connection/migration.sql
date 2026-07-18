-- CreateTable
CREATE TABLE "DockerConnection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "encryptedCredential" BYTEA,
    "credentialNonce" BYTEA,
    "credentialKeyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DockerConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DockerConnection_ownerId_idx" ON "DockerConnection"("ownerId");

-- AddForeignKey
ALTER TABLE "DockerConnection" ADD CONSTRAINT "DockerConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

