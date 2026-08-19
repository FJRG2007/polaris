-- Deciding not to hear from somebody.
--
-- A person's own decision, which is what separates it from everything already in
-- this schema: a timeout is a room silencing somebody and ends by itself, a ban
-- is a door closed by whoever runs a space. This is one account about one other
-- account, it lasts until it is lifted, and the person blocked is never told.
--
-- The pair is the key, so blocking somebody twice is one row. The direction is
-- kept because it is not symmetric - each side can hold one without the other -
-- and the second index is what answers "who has blocked me", which every check
-- on the way to reaching somebody asks.
CREATE TABLE "UserBlock" (
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("blockerId", "blockedId")
);

CREATE INDEX "UserBlock_blockedId_idx" ON "UserBlock"("blockedId");

ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockerId_fkey"
    FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockedId_fkey"
    FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
