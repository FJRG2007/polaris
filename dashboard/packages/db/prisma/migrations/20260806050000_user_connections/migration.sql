-- One table for every outside account somebody links to their Polaris account.
--
-- GitHub identities and calendar links were the same shape twice: an account the
-- provider itself vouched for, owned by one person, on top of an application the
-- operator connected once. They become rows of one table, which is what lets a
-- person hold more than one account per provider and lets one screen show them
-- all.
--
-- Both existing tables are copied across before they are dropped, so nobody has
-- to link anything again: a GitHub identity keeps its numeric id as the account
-- id, and a calendar link carries its encrypted refresh token over untouched.

-- CreateTable
CREATE TABLE "UserConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "method" TEXT NOT NULL DEFAULT 'oauth',
    "encryptedToken" BYTEA,
    "tokenNonce" BYTEA,
    "tokenKeyId" TEXT,
    "scope" TEXT NOT NULL DEFAULT '',
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserConnection_provider_accountId_key" ON "UserConnection"("provider", "accountId");

-- CreateIndex
CREATE INDEX "UserConnection_userId_provider_idx" ON "UserConnection"("userId", "provider");

-- AddForeignKey
ALTER TABLE "UserConnection" ADD CONSTRAINT "UserConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the GitHub identities over. They hold no credential: what they record is
-- who somebody is on GitHub, which is exactly what a link with no token is.
INSERT INTO "UserConnection" ("id", "userId", "provider", "accountId", "label", "avatarUrl", "method", "scope", "linkedAt", "updatedAt")
SELECT "id", "userId", 'github', "githubId"::text, "login", "avatarUrl", 'oauth', '', "linkedAt", "linkedAt"
FROM "GithubIdentity";

-- And the calendar links, with their encrypted refresh token intact.
INSERT INTO "UserConnection" ("id", "userId", "provider", "accountId", "label", "method", "encryptedToken", "tokenNonce", "tokenKeyId", "scope", "linkedAt", "updatedAt")
SELECT "id", "userId", "provider", "accountId", "email", 'oauth', "encryptedToken", "tokenNonce", "tokenKeyId", "scope", "linkedAt", "updatedAt"
FROM "CalendarLink";

-- DropTable
DROP TABLE "GithubIdentity";

-- DropTable
DROP TABLE "CalendarLink";
