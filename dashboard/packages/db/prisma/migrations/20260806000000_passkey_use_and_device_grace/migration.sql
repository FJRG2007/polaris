-- What a passkey is used for, and how long a device has been on the account.
--
-- A passkey row could say who registered it and where it works, and nothing
-- about whether it has ever been used since. So the account could list a
-- credential it no longer recognises and offer no way to tell whether it is a
-- forgotten laptop or somebody else's key: the two look identical until one of
-- them signs in. The date of the last assertion is what separates them, and the
-- address the registration came from is what answers "was that me?" about the
-- moment it was added.
--
-- Nullable with no backfill throughout. Nothing recorded any of this before this
-- ran, and a passkey shown as never used is the honest reading of a row nobody
-- was watching - inventing a date would point somebody at the wrong credential.

ALTER TABLE "Passkey" ADD COLUMN "userAgentBrands" TEXT;
ALTER TABLE "Passkey" ADD COLUMN "ip" TEXT;
ALTER TABLE "Passkey" ADD COLUMN "lastUsedAt" TIMESTAMP(3);

-- The brands a browser announces about itself, wherever Polaris already keeps
-- what it claimed to be. Brave, Vivaldi and Arc all report themselves as Chrome
-- in the user-agent deliberately, so without this every device list names them
-- wrong - and names one machine differently depending on which list it is in.

ALTER TABLE "SessionState" ADD COLUMN "userAgentBrands" TEXT;
ALTER TABLE "TrustedDevice" ADD COLUMN "userAgentBrands" TEXT;

-- A recent password confirmation, and the wait a new device serves.
--
-- The confirmation exists because registering a passkey is adding a way in, and
-- until now the browser could do it on an open session alone. It is bound to the
-- session that proved it and expires in minutes, so it is a step in one flow
-- rather than a standing permission.
--
-- The wait is off by default. Turning it on trades a genuine new laptop being
-- unable to touch Security for a week against a stolen password being unable to
-- lock the owner out, and which of those matters more is the owner's to decide.

ALTER TABLE "UserSecurity" ADD COLUMN "reauthUntil" TIMESTAMP(3);
ALTER TABLE "UserSecurity" ADD COLUMN "reauthSessionId" UUID;
ALTER TABLE "UserSecurity" ADD COLUMN "newDeviceGraceDays" INTEGER NOT NULL DEFAULT 0;

-- Every browser the account has signed in from, and when it first did.
--
-- Sessions cannot answer that: they are ended and they expire, so the oldest
-- laptop on the account would look new again the morning after it was signed
-- out - and the wait above would restart with it, which is exactly backwards.
-- The remembered-device rows cannot answer it either; they only exist for the
-- browsers that asked to skip the challenge.
--
-- Existing devices are not backfilled, so the first sign-in after this runs is
-- what dates them. That is only visible to an account that turns the wait on,
-- and it errs towards making a device wait rather than towards letting one
-- through, which is the right way round for a control that exists to slow an
-- intruder down.

-- CreateTable
CREATE TABLE "AccountDevice" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "userAgent" TEXT NOT NULL,
    "userAgentBrands" TEXT,
    "ip" TEXT,
    "host" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDevice_userId_userAgent_key" ON "AccountDevice"("userId", "userAgent");

-- CreateIndex
CREATE INDEX "AccountDevice_userId_idx" ON "AccountDevice"("userId");

-- AddForeignKey
ALTER TABLE "AccountDevice" ADD CONSTRAINT "AccountDevice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
