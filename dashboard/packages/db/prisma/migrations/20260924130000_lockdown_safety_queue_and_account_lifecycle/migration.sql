-- Shutting an account down, switching one off, asking for one to be deleted, and
-- the queue an administrator reads all of that from.
--
-- Four things, and they are one change because they are one situation: an
-- account that its owner no longer trusts, or no longer wants.
--
-- **Lockdown** is the emergency. The owner thinks somebody else is in their
-- account and presses one switch: nothing about how the account is protected can
-- be changed, no new way in can be added, and no new session may be opened. What
-- it deliberately does not do is end the sessions already open - an owner locked
-- out of the screen they need is an owner who cannot lift it again, and the whole
-- point is that they keep the account while somebody sorts it out. An
-- administrator is told the moment it goes on, because it is the one setting
-- whose meaning is "something has gone wrong here".
--
-- **Disabled** is the quiet one: the account goes away and comes back by signing
-- in. Its own column rather than a reason on `bannedAt`, because the two have to
-- behave differently in the one place it matters - signing in restores this and
-- must never lift a suspension the instance imposed. An account can hold both.
--
-- **Deletion** is the same shape with a longer wait and an ending. Nothing is
-- removed until the wait is up, and signing in before then calls it off: the
-- account somebody deletes in anger on a Friday is the account they want back on
-- Monday, and the only credential needed to get it back is the one they already
-- have.
--
-- **SafetyCase** is where the first of those lands, beside the reports about
-- people rather than about messages. It is deliberately not folded into
-- ChatReport: that row is anchored to a message and carries what the message
-- said, and forcing a person or a lockdown through it would mean a table of
-- mostly-null message columns and a status that means different things per row.
-- Both are read from one screen, because "what needs looking at" is one question
-- and an instance that answers it in two places answers it in neither.
--
-- **StepUpGrant** is what stops a screen asking for a proof once per switch. It
-- is scoped to one session and one purpose and it lasts two minutes: a proof
-- given on a laptop is not a proof given on a phone, and a proof given to add a
-- passkey is not permission to change how sign-in works.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "disabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UserSecurity" ADD COLUMN     "lockdownAt" TIMESTAMP(3),
ADD COLUMN     "lockdownNote" TEXT;

-- CreateTable
CREATE TABLE "SafetyCase" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "reporterId" UUID,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "handledById" UUID,
    "handledAt" TIMESTAMP(3),
    "outcome" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetyCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepUpGrant" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepUpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SafetyCase_status_createdAt_idx" ON "SafetyCase"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SafetyCase_subjectId_idx" ON "SafetyCase"("subjectId");

-- CreateIndex
CREATE INDEX "StepUpGrant_userId_idx" ON "StepUpGrant"("userId");

-- CreateIndex
CREATE INDEX "StepUpGrant_expiresAt_idx" ON "StepUpGrant"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StepUpGrant_sessionId_purpose_key" ON "StepUpGrant"("sessionId", "purpose");

-- AddForeignKey
ALTER TABLE "SafetyCase" ADD CONSTRAINT "SafetyCase_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyCase" ADD CONSTRAINT "SafetyCase_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyCase" ADD CONSTRAINT "SafetyCase_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepUpGrant" ADD CONSTRAINT "StepUpGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

