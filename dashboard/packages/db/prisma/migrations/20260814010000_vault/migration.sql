-- CreateTable
CREATE TABLE "VaultAccount" (
    "userId" UUID NOT NULL,
    "kdf" INTEGER NOT NULL DEFAULT 0,
    "kdfIterations" INTEGER NOT NULL DEFAULT 600000,
    "kdfMemory" INTEGER,
    "kdfParallelism" INTEGER,
    "masterPasswordHash" TEXT NOT NULL,
    "masterPasswordHint" TEXT,
    "protectedKey" TEXT NOT NULL,
    "publicKey" TEXT,
    "privateKey" TEXT,
    "securityStamp" TEXT NOT NULL,
    "revisionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "VaultCipher" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "organizationId" UUID,
    "folderId" UUID,
    "type" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "reprompt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedDate" TIMESTAMP(3),

    CONSTRAINT "VaultCipher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultFolder" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "revisionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultFavorite" (
    "userId" UUID NOT NULL,
    "cipherId" UUID NOT NULL,

    CONSTRAINT "VaultFavorite_pkey" PRIMARY KEY ("userId","cipherId")
);

-- CreateTable
CREATE TABLE "VaultOrganization" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultOrganization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultOrgUser" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID,
    "email" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "type" INTEGER NOT NULL DEFAULT 2,
    "key" TEXT,
    "accessAll" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultOrgUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultCollection" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT,

    CONSTRAINT "VaultCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultCollectionCipher" (
    "collectionId" UUID NOT NULL,
    "cipherId" UUID NOT NULL,

    CONSTRAINT "VaultCollectionCipher_pkey" PRIMARY KEY ("collectionId","cipherId")
);

-- CreateTable
CREATE TABLE "VaultCollectionAccess" (
    "collectionId" UUID NOT NULL,
    "orgUserId" UUID NOT NULL,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "hidePasswords" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VaultCollectionAccess_pkey" PRIMARY KEY ("collectionId","orgUserId")
);

-- CreateTable
CREATE TABLE "VaultAttachment" (
    "id" UUID NOT NULL,
    "cipherId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "key" TEXT,
    "size" BIGINT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultSend" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "passwordHash" TEXT,
    "maxAccessCount" INTEGER,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "expirationDate" TIMESTAMP(3),
    "deletionDate" TIMESTAMP(3) NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "hideEmail" BOOLEAN NOT NULL DEFAULT false,
    "accessId" TEXT NOT NULL,
    "storedPath" TEXT,
    "fileSize" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultDevice" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" INTEGER NOT NULL,
    "pushToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultRefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID,
    "tokenHash" TEXT NOT NULL,
    "stamp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "VaultRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultEmergencyAccess" (
    "id" UUID NOT NULL,
    "grantorId" UUID NOT NULL,
    "granteeId" UUID,
    "email" TEXT NOT NULL,
    "type" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 0,
    "waitDays" INTEGER NOT NULL DEFAULT 7,
    "keyEncrypted" TEXT,
    "recoveryInitiatedDate" TIMESTAMP(3),
    "lastNotificationDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultEmergencyAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VaultCipher_userId_idx" ON "VaultCipher"("userId");

-- CreateIndex
CREATE INDEX "VaultCipher_organizationId_idx" ON "VaultCipher"("organizationId");

-- CreateIndex
CREATE INDEX "VaultCipher_folderId_idx" ON "VaultCipher"("folderId");

-- CreateIndex
CREATE INDEX "VaultFolder_userId_idx" ON "VaultFolder"("userId");

-- CreateIndex
CREATE INDEX "VaultFavorite_cipherId_idx" ON "VaultFavorite"("cipherId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultOrganization_organizationId_key" ON "VaultOrganization"("organizationId");

-- CreateIndex
CREATE INDEX "VaultOrgUser_userId_idx" ON "VaultOrgUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultOrgUser_orgId_email_key" ON "VaultOrgUser"("orgId", "email");

-- CreateIndex
CREATE INDEX "VaultCollection_orgId_idx" ON "VaultCollection"("orgId");

-- CreateIndex
CREATE INDEX "VaultCollectionCipher_cipherId_idx" ON "VaultCollectionCipher"("cipherId");

-- CreateIndex
CREATE INDEX "VaultCollectionAccess_orgUserId_idx" ON "VaultCollectionAccess"("orgUserId");

-- CreateIndex
CREATE INDEX "VaultAttachment_cipherId_idx" ON "VaultAttachment"("cipherId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultSend_accessId_key" ON "VaultSend"("accessId");

-- CreateIndex
CREATE INDEX "VaultSend_userId_idx" ON "VaultSend"("userId");

-- CreateIndex
CREATE INDEX "VaultDevice_userId_idx" ON "VaultDevice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultDevice_userId_identifier_key" ON "VaultDevice"("userId", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "VaultRefreshToken_tokenHash_key" ON "VaultRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "VaultRefreshToken_userId_idx" ON "VaultRefreshToken"("userId");

-- CreateIndex
CREATE INDEX "VaultEmergencyAccess_granteeId_idx" ON "VaultEmergencyAccess"("granteeId");

-- CreateIndex
CREATE UNIQUE INDEX "VaultEmergencyAccess_grantorId_email_key" ON "VaultEmergencyAccess"("grantorId", "email");

-- AddForeignKey
ALTER TABLE "VaultAccount" ADD CONSTRAINT "VaultAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultCipher" ADD CONSTRAINT "VaultCipher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultCipher" ADD CONSTRAINT "VaultCipher_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "VaultOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultCipher" ADD CONSTRAINT "VaultCipher_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "VaultFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultFolder" ADD CONSTRAINT "VaultFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultFavorite" ADD CONSTRAINT "VaultFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultFavorite" ADD CONSTRAINT "VaultFavorite_cipherId_fkey" FOREIGN KEY ("cipherId") REFERENCES "VaultCipher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultOrganization" ADD CONSTRAINT "VaultOrganization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultOrgUser" ADD CONSTRAINT "VaultOrgUser_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "VaultOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultOrgUser" ADD CONSTRAINT "VaultOrgUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultCollection" ADD CONSTRAINT "VaultCollection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "VaultOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultCollectionCipher" ADD CONSTRAINT "VaultCollectionCipher_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "VaultCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultCollectionCipher" ADD CONSTRAINT "VaultCollectionCipher_cipherId_fkey" FOREIGN KEY ("cipherId") REFERENCES "VaultCipher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultCollectionAccess" ADD CONSTRAINT "VaultCollectionAccess_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "VaultCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultCollectionAccess" ADD CONSTRAINT "VaultCollectionAccess_orgUserId_fkey" FOREIGN KEY ("orgUserId") REFERENCES "VaultOrgUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultAttachment" ADD CONSTRAINT "VaultAttachment_cipherId_fkey" FOREIGN KEY ("cipherId") REFERENCES "VaultCipher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultSend" ADD CONSTRAINT "VaultSend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultDevice" ADD CONSTRAINT "VaultDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultRefreshToken" ADD CONSTRAINT "VaultRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultRefreshToken" ADD CONSTRAINT "VaultRefreshToken_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "VaultDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultEmergencyAccess" ADD CONSTRAINT "VaultEmergencyAccess_grantorId_fkey" FOREIGN KEY ("grantorId") REFERENCES "VaultAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultEmergencyAccess" ADD CONSTRAINT "VaultEmergencyAccess_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "VaultAccount"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

