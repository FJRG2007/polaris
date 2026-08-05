-- What each provider actually serves.
--
-- Replaces a hand-kept list that offered one model per provider: whoever
-- connected a Groq key could choose `gpt-oss-120b` or nothing, and no screen
-- could say what it holds. Downloaded from the providers' public catalogue and
-- refreshed on a schedule, so a deployment that never reaches it simply falls
-- back to that one default rather than showing an empty picker.
CREATE TABLE "AgentModel" (
    "slug" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contextTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "effortRungs" TEXT NOT NULL DEFAULT '[]',
    "reasoning" BOOLEAN NOT NULL DEFAULT false,
    "attachment" BOOLEAN NOT NULL DEFAULT false,
    "costInput" DOUBLE PRECISION,
    "costOutput" DOUBLE PRECISION,
    "releaseDate" TEXT,
    "refreshedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentModel_pkey" PRIMARY KEY ("slug")
);

CREATE INDEX "AgentModel_provider_idx" ON "AgentModel"("provider");
