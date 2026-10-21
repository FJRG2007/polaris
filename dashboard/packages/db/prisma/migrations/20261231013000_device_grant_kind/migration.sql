-- The device grant also connects the Stream Deck plugin; existing rows are CLI requests.
ALTER TABLE "CliAuthorization" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'cli';
