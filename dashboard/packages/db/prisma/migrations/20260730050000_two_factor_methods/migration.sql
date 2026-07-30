-- Which second-factor methods an account accepts, and which one it offers
-- first. Existing rows keep the authenticator alone, which is what they had.
ALTER TABLE "UserSecurity" ADD COLUMN "twoFactorMethods" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "UserSecurity" ADD COLUMN "twoFactorPreferred" TEXT;

-- The number a second-factor code can be sent to: one per account, with its
-- pending confirmation code (hashed) on the same row.
CREATE TABLE "UserPhone" (
    "userId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPhone_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserPhone" ADD CONSTRAINT "UserPhone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
