-- The AI provider catalogue as data (apps/web/src/lib/integrations/provider-catalog.ts):
-- seeded from code on boot, widened from the public model index, and added to by
-- an operator. Additive; nothing reads a column that an older build wrote.
CREATE TABLE IF NOT EXISTS "ModelProviderEntry" (
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 100,
    "envVar" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "docsUrl" TEXT NOT NULL DEFAULT '',
    "keyUrl" TEXT,
    "probe" TEXT,
    "baseUrl" TEXT,
    "wire" TEXT,
    "anthropicBaseUrl" TEXT,
    "outsideIndex" BOOLEAN NOT NULL DEFAULT false,
    "defaultModelSlug" TEXT NOT NULL DEFAULT '',
    "defaultModelLabel" TEXT NOT NULL DEFAULT '',
    "freeKind" TEXT,
    "freeNote" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ModelProviderEntry_pkey" PRIMARY KEY ("slug")
);

CREATE INDEX IF NOT EXISTS "ModelProviderEntry_kind_idx" ON "ModelProviderEntry"("kind");
CREATE INDEX IF NOT EXISTS "ModelProviderEntry_freeKind_idx" ON "ModelProviderEntry"("freeKind");
CREATE INDEX IF NOT EXISTS "ModelProviderEntry_source_idx" ON "ModelProviderEntry"("source");
CREATE INDEX IF NOT EXISTS "ModelProviderEntry_rank_name_idx" ON "ModelProviderEntry"("rank", "name");

CREATE TABLE IF NOT EXISTS "ModelProviderIndexState" (
    "id" TEXT NOT NULL,
    "etag" TEXT,
    "refreshedAt" TIMESTAMP(3),
    "providers" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ModelProviderIndexState_pkey" PRIMARY KEY ("id")
);
