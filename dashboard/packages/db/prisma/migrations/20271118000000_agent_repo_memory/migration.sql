-- What a person's agent remembers about one repository, carried between boxes.
-- Additive and rerunnable.
CREATE TABLE IF NOT EXISTS "AgentRepoMemory" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRepoMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentRepoMemory_userId_repoFullName_key" ON "AgentRepoMemory"("userId", "repoFullName");
