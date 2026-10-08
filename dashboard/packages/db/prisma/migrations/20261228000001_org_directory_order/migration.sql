-- The organizations list reads them a page at a time, oldest first, resuming
-- after the last one it showed. This is the order it reads them in.
--
-- Written so that running it a second time is a no-op. Undone by dropping the
-- index.

CREATE INDEX IF NOT EXISTS "Organization_createdAt_id_idx" ON "Organization"("createdAt", "id");
