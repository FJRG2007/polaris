-- iPhones that ring for a call with the app closed: each one's VoIP push token.
--
-- Additive only: one new table. Written to be safe to run twice.
CREATE TABLE IF NOT EXISTS "MobileVoipToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobileVoipToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MobileVoipToken_token_key" ON "MobileVoipToken"("token");
CREATE INDEX IF NOT EXISTS "MobileVoipToken_userId_idx" ON "MobileVoipToken"("userId");
ALTER TABLE "MobileVoipToken" DROP CONSTRAINT IF EXISTS "MobileVoipToken_userId_fkey";
ALTER TABLE "MobileVoipToken" ADD CONSTRAINT "MobileVoipToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
