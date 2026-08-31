-- AlterTable
ALTER TABLE "AgentRepo" ADD COLUMN     "enigma" TEXT;

-- AlterTable
ALTER TABLE "AgentDefaults" ADD COLUMN     "enigma" TEXT;

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" UUID NOT NULL,
    "repoId" UUID NOT NULL,
    "startedById" UUID,
    "title" TEXT NOT NULL,
    "cli" TEXT NOT NULL,
    "command" TEXT,
    "place" TEXT NOT NULL DEFAULT 'local',
    "hostId" UUID,
    "state" TEXT NOT NULL DEFAULT 'starting',
    "detail" TEXT NOT NULL DEFAULT '',
    "baseRef" TEXT NOT NULL DEFAULT '',
    "branch" TEXT NOT NULL,
    "workdir" TEXT NOT NULL DEFAULT '',
    "containerId" TEXT,
    "tokenHash" TEXT,
    "enigma" TEXT,
    "taskId" UUID,
    "error" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSessionEvent" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSessionMessage" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSessionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSession_repoId_createdAt_idx" ON "AgentSession"("repoId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSession_state_idx" ON "AgentSession"("state");

-- CreateIndex
CREATE INDEX "AgentSession_taskId_idx" ON "AgentSession"("taskId");

-- CreateIndex
CREATE INDEX "AgentSession_hostId_idx" ON "AgentSession"("hostId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_tokenHash_key" ON "AgentSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentSessionEvent_sessionId_createdAt_idx" ON "AgentSessionEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSessionMessage_sessionId_createdAt_idx" ON "AgentSessionMessage"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "AgentRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSessionEvent" ADD CONSTRAINT "AgentSessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSessionMessage" ADD CONSTRAINT "AgentSessionMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

