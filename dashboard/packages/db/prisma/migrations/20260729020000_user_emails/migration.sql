-- Alternate addresses a user owns. The sign-in address stays on User.email; this
-- table holds the rest, any of which can be flagged as a recovery contact. The
-- unique index is what stops the same address being claimed by two accounts.
CREATE TABLE "UserEmail" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "recovery" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEmail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserEmail_email_key" ON "UserEmail"("email");
CREATE INDEX "UserEmail_userId_idx" ON "UserEmail"("userId");
ALTER TABLE "UserEmail" ADD CONSTRAINT "UserEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
