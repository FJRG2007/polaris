-- A sealed variable is write-only: still injected and resolvable by references,
-- never readable again from the UI or the API. A generator (`${{ secret(32) }}`)
-- draws a fresh value for every environment made from this one. Both default to
-- what every existing variable already is: readable, with no generator.
ALTER TABLE "EnvVar" ADD COLUMN "sealed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "generator" TEXT;
