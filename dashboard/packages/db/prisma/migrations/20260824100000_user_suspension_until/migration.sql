-- A ban that ends. Nothing decides "is this account banned" from this column -
-- `bannedAt` alone does that - so a suspension is lifted by the sweep clearing
-- that column once this moment has passed.
ALTER TABLE "User" ADD COLUMN "bannedUntil" TIMESTAMP(3);
