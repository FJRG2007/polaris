-- AlterTable
ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "folderId" UUID,
ADD COLUMN IF NOT EXISTS "frontmatter" TEXT,
ADD COLUMN IF NOT EXISTS "spaceId" UUID;

-- CreateTable
CREATE TABLE IF NOT EXISTS "NoteSpace" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "orgId" UUID,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "color" TEXT NOT NULL DEFAULT '#7c5cff',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteSpace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "NoteSpaceMember" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteSpaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "NoteSpaceTeam" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteSpaceTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "NoteFolder" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "spaceId" UUID,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteFolder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NoteSpace_ownerId_idx" ON "NoteSpace"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NoteSpace_orgId_idx" ON "NoteSpace"("orgId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NoteSpaceMember_userId_idx" ON "NoteSpaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "NoteSpaceMember_spaceId_userId_key" ON "NoteSpaceMember"("spaceId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NoteSpaceTeam_teamId_idx" ON "NoteSpaceTeam"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "NoteSpaceTeam_spaceId_teamId_key" ON "NoteSpaceTeam"("spaceId", "teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NoteFolder_ownerId_spaceId_idx" ON "NoteFolder"("ownerId", "spaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NoteFolder_spaceId_idx" ON "NoteFolder"("spaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NoteFolder_parentId_idx" ON "NoteFolder"("parentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Note_spaceId_archived_updatedAt_idx" ON "Note"("spaceId", "archived", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Note_folderId_idx" ON "Note"("folderId");

-- AddForeignKey
ALTER TABLE "Note" DROP CONSTRAINT IF EXISTS "Note_spaceId_fkey";
ALTER TABLE "Note" ADD CONSTRAINT "Note_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "NoteSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" DROP CONSTRAINT IF EXISTS "Note_folderId_fkey";
ALTER TABLE "Note" ADD CONSTRAINT "Note_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "NoteFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSpace" DROP CONSTRAINT IF EXISTS "NoteSpace_ownerId_fkey";
ALTER TABLE "NoteSpace" ADD CONSTRAINT "NoteSpace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSpace" DROP CONSTRAINT IF EXISTS "NoteSpace_orgId_fkey";
ALTER TABLE "NoteSpace" ADD CONSTRAINT "NoteSpace_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSpaceMember" DROP CONSTRAINT IF EXISTS "NoteSpaceMember_spaceId_fkey";
ALTER TABLE "NoteSpaceMember" ADD CONSTRAINT "NoteSpaceMember_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "NoteSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSpaceMember" DROP CONSTRAINT IF EXISTS "NoteSpaceMember_userId_fkey";
ALTER TABLE "NoteSpaceMember" ADD CONSTRAINT "NoteSpaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSpaceTeam" DROP CONSTRAINT IF EXISTS "NoteSpaceTeam_spaceId_fkey";
ALTER TABLE "NoteSpaceTeam" ADD CONSTRAINT "NoteSpaceTeam_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "NoteSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSpaceTeam" DROP CONSTRAINT IF EXISTS "NoteSpaceTeam_teamId_fkey";
ALTER TABLE "NoteSpaceTeam" ADD CONSTRAINT "NoteSpaceTeam_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteFolder" DROP CONSTRAINT IF EXISTS "NoteFolder_ownerId_fkey";
ALTER TABLE "NoteFolder" ADD CONSTRAINT "NoteFolder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteFolder" DROP CONSTRAINT IF EXISTS "NoteFolder_spaceId_fkey";
ALTER TABLE "NoteFolder" ADD CONSTRAINT "NoteFolder_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "NoteSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteFolder" DROP CONSTRAINT IF EXISTS "NoteFolder_parentId_fkey";
ALTER TABLE "NoteFolder" ADD CONSTRAINT "NoteFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "NoteFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

