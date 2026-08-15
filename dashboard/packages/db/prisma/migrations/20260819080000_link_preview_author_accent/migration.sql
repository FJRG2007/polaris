-- What a link turned out to be now carries who made it and what colour the site
-- says it is.
ALTER TABLE "LinkPreview" ADD COLUMN "author" TEXT NOT NULL DEFAULT '';
ALTER TABLE "LinkPreview" ADD COLUMN "accent" TEXT;

-- Every row already stored was looked up without either of those, and a look is
-- trusted for a week - so without this, a card posted yesterday would keep its
-- missing channel and its missing colour until next Tuesday. Ageing them out
-- rather than deleting them keeps every card on screen exactly as it is until
-- the fresh answer arrives.
UPDATE "LinkPreview" SET "fetchedAt" = TIMESTAMP '1970-01-01 00:00:00';
