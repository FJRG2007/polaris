-- Remembered devices, one row each.
--
-- Ticking "remember this device" at the second-factor challenge buys that
-- browser thirty days of signing in on the password alone. better-auth stores
-- that pass as a Verification row holding a random identifier, the user id and
-- an expiry - and nothing else, which is why Account > Security could only say
-- how many existed and offer to forget every one of them at once. A person who
-- wanted to end the pass on a phone they no longer have had to end it on their
-- laptop too.
--
-- This table is the missing half: what the device looked like at the moment it
-- was remembered. It is a label and never the pass itself - the Verification row
-- is still what decides whether the challenge is skipped - so a row missing here
-- costs a name in a list, and a row deleted here is accompanied by deleting the
-- pass it describes.
--
-- identifier is unique because it is the pass being described, and it is
-- followed rather than fixed: better-auth rotates the identifier on every
-- sign-in it admits, so one long-lived device stays one row instead of leaving a
-- trail of dead ones.
--
-- userAgent, ip and host are recorded the same way a session's are, and read the
-- same way: client-supplied labels, shown to help somebody recognise their own
-- device, never consulted to decide anything.

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "host" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_identifier_key" ON "TrustedDevice"("identifier");

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_idx" ON "TrustedDevice"("userId");

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
