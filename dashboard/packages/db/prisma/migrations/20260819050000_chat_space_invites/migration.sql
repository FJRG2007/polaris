-- Invitations into a space.
--
-- The code is the whole credential, which is why both bounds live on the row and
-- are checked on every use rather than only when one is made: a link that can be
-- forwarded is a link that will be. Null in either column means "no bound",
-- which is a decision somebody made rather than a missing value.
--
-- Uses are counted rather than the people recorded. Who accepted is already a
-- membership row, and a second list of it would be a second thing to keep right.

-- CreateTable
CREATE TABLE "ChatSpaceInvite" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSpaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatSpaceInvite_code_key" ON "ChatSpaceInvite"("code");

-- CreateIndex
CREATE INDEX "ChatSpaceInvite_spaceId_createdAt_idx" ON "ChatSpaceInvite"("spaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChatSpaceInvite" ADD CONSTRAINT "ChatSpaceInvite_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSpaceInvite" ADD CONSTRAINT "ChatSpaceInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
