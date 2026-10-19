-- Polar, the dashboard's assistant: one person's conversations and their messages.
CREATE TABLE "PolarThread" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "choice" JSONB,
    "queue" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolarThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolarMessage" (
    "id" TEXT NOT NULL,
    "threadId" UUID NOT NULL,
    "parentId" TEXT,
    "role" TEXT NOT NULL,
    "parts" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolarMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PolarThread_userId_updatedAt_idx" ON "PolarThread"("userId", "updatedAt" DESC);

CREATE INDEX "PolarMessage_threadId_createdAt_idx" ON "PolarMessage"("threadId", "createdAt");

ALTER TABLE "PolarThread" ADD CONSTRAINT "PolarThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PolarMessage" ADD CONSTRAINT "PolarMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "PolarThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
