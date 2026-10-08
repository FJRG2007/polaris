-- The people screen lists the newest pending invitations. This is the order it
-- reads them in.
--
-- Written so that running it a second time is a no-op. Undone by dropping the
-- index.

CREATE INDEX IF NOT EXISTS "Invite_acceptedAt_createdAt_idx" ON "Invite"("acceptedAt", "createdAt");
