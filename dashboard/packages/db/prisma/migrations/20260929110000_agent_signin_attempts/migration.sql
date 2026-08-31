-- CreateTable
CREATE TABLE "AgentSigninAttempt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "env" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentSigninAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSigninAttempt_userId_endedAt_idx" ON "AgentSigninAttempt"("userId", "endedAt");

-- CreateIndex
CREATE INDEX "AgentSigninAttempt_endedAt_startedAt_idx" ON "AgentSigninAttempt"("endedAt", "startedAt");

