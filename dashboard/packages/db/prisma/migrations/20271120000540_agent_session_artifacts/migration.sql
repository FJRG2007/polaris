-- A Polar Code session's deliverables and their versions
-- (apps/web/src/lib/agents/session-artifacts.ts). Rerunnable.
CREATE TABLE IF NOT EXISTS "AgentSessionArtifact" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentSessionArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentSessionArtifact_sessionId_path_key" ON "AgentSessionArtifact"("sessionId", "path");
CREATE INDEX IF NOT EXISTS "AgentSessionArtifact_sessionId_updatedAt_idx" ON "AgentSessionArtifact"("sessionId", "updatedAt");

ALTER TABLE "AgentSessionArtifact" DROP CONSTRAINT IF EXISTS "AgentSessionArtifact_sessionId_fkey";
ALTER TABLE "AgentSessionArtifact" ADD CONSTRAINT "AgentSessionArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AgentSessionArtifactVersion" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "connectionId" TEXT,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSessionArtifactVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentSessionArtifactVersion_artifactId_version_key" ON "AgentSessionArtifactVersion"("artifactId", "version");

ALTER TABLE "AgentSessionArtifactVersion" DROP CONSTRAINT IF EXISTS "AgentSessionArtifactVersion_artifactId_fkey";
ALTER TABLE "AgentSessionArtifactVersion" ADD CONSTRAINT "AgentSessionArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "AgentSessionArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
