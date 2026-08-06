-- The account somebody named to take over their own if they die. One row per
-- account, written only by that account.
CREATE TABLE "AccountSuccessor" (
    "userId" UUID NOT NULL,
    "successorId" UUID NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSuccessor_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "AccountSuccessor_successorId_idx" ON "AccountSuccessor"("successorId");

ALTER TABLE "AccountSuccessor" ADD CONSTRAINT "AccountSuccessor_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountSuccessor" ADD CONSTRAINT "AccountSuccessor_successorId_fkey"
    FOREIGN KEY ("successorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
