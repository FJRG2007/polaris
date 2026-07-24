-- Unify contacts into a person with several platform identities. A Contact is now
-- a person (name + note); each messaging handle (platform + peer id) becomes a
-- ContactIdentity. Existing contacts that share an owner and name are merged into
-- one person, and every prior (platform, peer id) is preserved as an identity.

-- 0. gen_random_uuid() below is built in on PG 13+ but lives in pgcrypto on older
--    instances; ensure it resolves everywhere (fresh envs included).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. New identity table. The person link (FK) is added after the merge trims Contact.
CREATE TABLE "ContactIdentity" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactIdentity_pkey" PRIMARY KEY ("id")
);

-- 2. Pick one canonical person per (owner, name): the earliest contact row.
CREATE TEMPORARY TABLE "_contact_canon" AS
SELECT c."id" AS old_id,
       (
           SELECT c2."id"
           FROM "Contact" c2
           WHERE c2."ownerId" = c."ownerId" AND c2."name" = c."name"
           ORDER BY c2."createdAt" ASC, c2."id" ASC
           LIMIT 1
       ) AS canon_id
FROM "Contact" c;

-- 3. Preserve every prior handle as an identity on its canonical person, dropping
--    exact (owner, platform, peer) duplicates the merge would collide on.
INSERT INTO "ContactIdentity" ("id", "ownerId", "contactId", "platform", "peerId", "createdAt")
SELECT DISTINCT ON (c."ownerId", c."platform", c."peerId")
       gen_random_uuid(), c."ownerId", canon."canon_id", c."platform", c."peerId", c."createdAt"
FROM "Contact" c
JOIN "_contact_canon" canon ON canon."old_id" = c."id"
ORDER BY c."ownerId", c."platform", c."peerId", c."createdAt" ASC;

-- 4. Fold each merge group's distinct non-empty notes onto its canonical person
--    before the duplicates are dropped, so no note text is lost. Notes are ordered
--    oldest-first (canonical leads) and de-duplicated, newline-joined. Each source
--    note was created under the same 500-char cap as updateContactSchema.note, so we
--    append whole notes only while the newline-joined running length stays <= 500,
--    keeping the merged note re-savable in the editor without cutting any note text.
UPDATE "Contact" c
SET "note" = merged.notes
FROM (
    SELECT canon_id, string_agg(note_text, E'\n' ORDER BY first_seen, note_text) AS notes
    FROM (
        SELECT canon_id, note_text, first_seen,
               sum(char_length(note_text)) OVER w + (count(*) OVER w - 1) AS running_len
        FROM (
            SELECT canon."canon_id" AS canon_id,
                   trim(src."note") AS note_text,
                   min(src."createdAt") AS first_seen
            FROM "Contact" src
            JOIN "_contact_canon" canon ON canon."old_id" = src."id"
            WHERE src."note" IS NOT NULL AND trim(src."note") <> ''
            GROUP BY canon."canon_id", trim(src."note")
        ) distinct_notes
        WINDOW w AS (
            PARTITION BY canon_id ORDER BY first_seen, note_text
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )
    ) ranked
    WHERE running_len <= 500
    GROUP BY canon_id
) merged
WHERE c."id" = merged.canon_id AND merged.notes IS DISTINCT FROM c."note";

-- 5. Remove the now-redundant (non-canonical) person rows.
DELETE FROM "Contact" c
USING "_contact_canon" canon
WHERE canon."old_id" = c."id" AND canon."canon_id" <> c."id";

DROP TABLE "_contact_canon";

-- 6. Contact keeps only person fields now; the handle columns moved to identities.
--    Dropping them also drops the old (ownerId, platform, peerId) unique index.
ALTER TABLE "Contact" DROP COLUMN "platform";
ALTER TABLE "Contact" DROP COLUMN "peerId";

-- 7. Identity constraints and the person link.
CREATE UNIQUE INDEX "ContactIdentity_ownerId_platform_peerId_key" ON "ContactIdentity"("ownerId", "platform", "peerId");
CREATE INDEX "ContactIdentity_contactId_idx" ON "ContactIdentity"("contactId");
CREATE INDEX "ContactIdentity_ownerId_idx" ON "ContactIdentity"("ownerId");
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
