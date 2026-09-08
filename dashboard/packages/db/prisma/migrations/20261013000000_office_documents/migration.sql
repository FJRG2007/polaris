-- One thing somebody made, whichever of the five it is: a document, a
-- spreadsheet, a deck, a diagram or a comparison. They are edited by five
-- surfaces and are otherwise the same row, and the differences live entirely
-- inside `content` - the merged CRDT state that lets several people type at
-- once. `excerpt` is the readable half, for the list and for search.
CREATE TABLE IF NOT EXISTS "OfficeDocument" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "orgId" UUID,
    "content" BYTEA,
    "excerpt" TEXT NOT NULL DEFAULT '',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "trashedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "editedById" UUID,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeDocument_pkey" PRIMARY KEY ("id")
);

-- When one person last opened one document, and whether they keep it to hand.
-- Both are facts about the pair rather than about the document: a deck somebody
-- else edited this morning is not more relevant to me than the one I was in
-- yesterday, and a star of mine must not show on somebody else's list.
CREATE TABLE IF NOT EXISTS "OfficeDocumentOpen" (
    "documentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "starred" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OfficeDocumentOpen_pkey" PRIMARY KEY ("documentId","userId")
);

CREATE INDEX IF NOT EXISTS "OfficeDocument_ownerId_kind_idx" ON "OfficeDocument"("ownerId", "kind");
CREATE INDEX IF NOT EXISTS "OfficeDocument_orgId_kind_idx" ON "OfficeDocument"("orgId", "kind");
CREATE INDEX IF NOT EXISTS "OfficeDocument_editedAt_idx" ON "OfficeDocument"("editedAt");
CREATE INDEX IF NOT EXISTS "OfficeDocumentOpen_userId_at_idx" ON "OfficeDocumentOpen"("userId", "at");

ALTER TABLE "OfficeDocument" DROP CONSTRAINT IF EXISTS "OfficeDocument_ownerId_fkey";
ALTER TABLE "OfficeDocument" ADD CONSTRAINT "OfficeDocument_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OfficeDocument" DROP CONSTRAINT IF EXISTS "OfficeDocument_orgId_fkey";
ALTER TABLE "OfficeDocument" ADD CONSTRAINT "OfficeDocument_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OfficeDocumentOpen" DROP CONSTRAINT IF EXISTS "OfficeDocumentOpen_documentId_fkey";
ALTER TABLE "OfficeDocumentOpen" ADD CONSTRAINT "OfficeDocumentOpen_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OfficeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OfficeDocumentOpen" DROP CONSTRAINT IF EXISTS "OfficeDocumentOpen_userId_fkey";
ALTER TABLE "OfficeDocumentOpen" ADD CONSTRAINT "OfficeDocumentOpen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
