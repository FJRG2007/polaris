-- The outside calendar one account reads its events from.
--
-- Two layers, for the same reason GitHub has two: the operator connects the
-- Google project once (an Integration row holding the client id and secret), and
-- each person authorizes their own account on top of it. Nothing here is written
-- by an administrator typing an address into a form - the row only exists once
-- Google itself has said who authorized.
--
-- The refresh token is the credential, so it is stored the way every other
-- Polaris secret is: envelope-encrypted under the master key, with the nonce and
-- key id beside it. A database dump therefore reaches nobody's calendar.
--
-- One row per user: a second calendar account would mean choosing which one the
-- calendar shows, and nothing has asked for that.

-- CreateTable
CREATE TABLE "CalendarLink" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "encryptedToken" BYTEA NOT NULL,
    "tokenNonce" BYTEA NOT NULL,
    "tokenKeyId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarLink_userId_key" ON "CalendarLink"("userId");

-- AddForeignKey
ALTER TABLE "CalendarLink" ADD CONSTRAINT "CalendarLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
