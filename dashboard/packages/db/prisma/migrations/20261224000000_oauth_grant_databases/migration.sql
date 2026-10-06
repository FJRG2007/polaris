-- Which databases a connected app may reach through the database tools: a JSON
-- array of connection ids, as the Databases app names them. Null on every grant
-- that already exists, which reads as "every database the person can open" -
-- exactly what those grants reached before the tools existed.
--
-- Written so that running it a second time is a no-op. Undone by
-- ALTER TABLE "OAuthGrant" DROP COLUMN IF EXISTS "databaseIds";

ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS "databaseIds" TEXT;
