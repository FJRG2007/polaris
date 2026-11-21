-- A space can ask before it lets people in: an invitation then files a request
-- that whoever runs the space answers. Off for every existing space, which is
-- how they admitted people before.
--
-- Additive only. Written so that running it a second time is a no-op.

ALTER TABLE "ChatSpace" ADD COLUMN IF NOT EXISTS "requireApproval" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "ChatSpaceJoinRequest" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSpaceJoinRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChatSpaceJoinRequest_spaceId_userId_key" ON "ChatSpaceJoinRequest"("spaceId", "userId");
CREATE INDEX IF NOT EXISTS "ChatSpaceJoinRequest_spaceId_createdAt_idx" ON "ChatSpaceJoinRequest"("spaceId", "createdAt");
ALTER TABLE "ChatSpaceJoinRequest" DROP CONSTRAINT IF EXISTS "ChatSpaceJoinRequest_spaceId_fkey";
ALTER TABLE "ChatSpaceJoinRequest" ADD CONSTRAINT "ChatSpaceJoinRequest_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "ChatSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatSpaceJoinRequest" DROP CONSTRAINT IF EXISTS "ChatSpaceJoinRequest_userId_fkey";
ALTER TABLE "ChatSpaceJoinRequest" ADD CONSTRAINT "ChatSpaceJoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
