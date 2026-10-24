-- Who a link opens for. Every existing link was a no-account link, so the
-- default keeps them meaning exactly that.
ALTER TABLE "AccessGrant" ADD COLUMN IF NOT EXISTS "linkAudience" TEXT NOT NULL DEFAULT 'anyone',
ADD COLUMN IF NOT EXISTS "linkOrgId" UUID;

-- "People with access", a page at a time.
CREATE INDEX IF NOT EXISTS "AccessGrant_subjectType_subjectId_createdAt_id_idx" ON "AccessGrant"("subjectType", "subjectId", "createdAt", "id");
