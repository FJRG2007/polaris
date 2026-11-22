-- Backlinks: an index of the `polaris:note/<id>` references in note bodies.
CREATE TABLE IF NOT EXISTS "NoteLink" (
    "sourceId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteLink_pkey" PRIMARY KEY ("sourceId","targetId")
);

CREATE INDEX IF NOT EXISTS "NoteLink_targetId_idx" ON "NoteLink"("targetId");

ALTER TABLE "NoteLink" DROP CONSTRAINT IF EXISTS "NoteLink_sourceId_fkey";
ALTER TABLE "NoteLink" ADD CONSTRAINT "NoteLink_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NoteLink" DROP CONSTRAINT IF EXISTS "NoteLink_targetId_fkey";
ALTER TABLE "NoteLink" ADD CONSTRAINT "NoteLink_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every note written before the index existed. The pattern is the one
-- noteLinkTargets() in @polaris/core reads, so the backfill and a save agree on
-- what a link is; the cast is safe because the pattern only matches a UUID.
INSERT INTO "NoteLink" ("sourceId", "targetId")
SELECT DISTINCT n."id", t."id"
FROM "Note" n
CROSS JOIN LATERAL regexp_matches(
    n."body",
    '\[[^\]]*\]\(polaris:note/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)',
    'g'
) AS m("groups")
JOIN "Note" t ON t."id" = lower(m."groups"[1])::uuid
WHERE t."id" <> n."id"
ON CONFLICT DO NOTHING;
