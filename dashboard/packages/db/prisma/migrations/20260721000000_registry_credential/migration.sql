-- Private container-registry credentials (owner-scoped, one per registry host).
CREATE TABLE "RegistryCredential" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "registry" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "encryptedPassword" BYTEA NOT NULL,
    "passwordNonce" BYTEA NOT NULL,
    "passwordKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistryCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistryCredential_ownerId_registry_key" ON "RegistryCredential"("ownerId", "registry");
CREATE INDEX "RegistryCredential_ownerId_idx" ON "RegistryCredential"("ownerId");
