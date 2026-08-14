-- CreateTable
CREATE TABLE "Snippet" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "tokenHash" TEXT,
    "encryptedToken" BYTEA,
    "tokenNonce" BYTEA,
    "tokenKeyId" TEXT,
    "passwordHash" TEXT,
    "maxViews" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "burnAfterRead" BOOLEAN NOT NULL DEFAULT false,
    "clientSealed" BOOLEAN NOT NULL DEFAULT false,
    "allowedCidrs" TEXT NOT NULL DEFAULT '[]',
    "allowedCountries" TEXT NOT NULL DEFAULT '[]',
    "allowedContinents" TEXT NOT NULL DEFAULT '[]',
    "requestId" UUID,
    "submittedByUserId" UUID,
    "submittedIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Snippet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnippetFile" (
    "id" UUID NOT NULL,
    "snippetId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT '',
    "encryptedBody" BYTEA NOT NULL,
    "bodyNonce" BYTEA NOT NULL,
    "bodyKeyId" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SnippetFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnippetInvite" (
    "id" UUID NOT NULL,
    "snippetId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "SnippetInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnippetAccessLog" (
    "id" UUID NOT NULL,
    "snippetId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "SnippetAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TextRequest" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "encryptedToken" BYTEA,
    "tokenNonce" BYTEA,
    "tokenKeyId" TEXT,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "passwordHash" TEXT,
    "requireLogin" BOOLEAN NOT NULL DEFAULT false,
    "allowedUsers" TEXT NOT NULL DEFAULT '[]',
    "maxLength" INTEGER NOT NULL,
    "maxSubmissions" INTEGER,
    "allowSealed" BOOLEAN NOT NULL DEFAULT false,
    "allowedCidrs" TEXT NOT NULL DEFAULT '[]',
    "allowedCountries" TEXT NOT NULL DEFAULT '[]',
    "allowedContinents" TEXT NOT NULL DEFAULT '[]',
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TextRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Snippet_tokenHash_key" ON "Snippet"("tokenHash");

-- CreateIndex
CREATE INDEX "Snippet_ownerId_requestId_updatedAt_idx" ON "Snippet"("ownerId", "requestId", "updatedAt");

-- CreateIndex
CREATE INDEX "Snippet_requestId_idx" ON "Snippet"("requestId");

-- CreateIndex
CREATE INDEX "Snippet_submittedByUserId_idx" ON "Snippet"("submittedByUserId");

-- CreateIndex
CREATE INDEX "SnippetFile_snippetId_idx" ON "SnippetFile"("snippetId");

-- CreateIndex
CREATE INDEX "SnippetInvite_userId_idx" ON "SnippetInvite"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SnippetInvite_snippetId_userId_key" ON "SnippetInvite"("snippetId", "userId");

-- CreateIndex
CREATE INDEX "SnippetAccessLog_snippetId_idx" ON "SnippetAccessLog"("snippetId");

-- CreateIndex
CREATE UNIQUE INDEX "TextRequest_tokenHash_key" ON "TextRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "TextRequest_ownerId_idx" ON "TextRequest"("ownerId");

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "TextRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnippetFile" ADD CONSTRAINT "SnippetFile_snippetId_fkey" FOREIGN KEY ("snippetId") REFERENCES "Snippet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnippetInvite" ADD CONSTRAINT "SnippetInvite_snippetId_fkey" FOREIGN KEY ("snippetId") REFERENCES "Snippet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnippetInvite" ADD CONSTRAINT "SnippetInvite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnippetAccessLog" ADD CONSTRAINT "SnippetAccessLog_snippetId_fkey" FOREIGN KEY ("snippetId") REFERENCES "Snippet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextRequest" ADD CONSTRAINT "TextRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

