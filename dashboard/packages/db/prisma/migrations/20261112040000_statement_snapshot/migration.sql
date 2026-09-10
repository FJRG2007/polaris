-- A month that has ended, frozen as its statement read the first time after, so
-- a statement already exported stays what it was after the prices, the currency
-- or the projects change.
--
-- A new table and nothing else: an instance that updates freezes each closed
-- month the next time somebody reads it. Written to be safe to run twice: the
-- entrypoint retries migrations, and an update can kill the container part-way
-- through one.
CREATE TABLE IF NOT EXISTS "StatementSnapshot" (
    "month" TEXT NOT NULL,
    "rates" TEXT,
    "projects" TEXT NOT NULL DEFAULT '[]',
    "keptFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementSnapshot_pkey" PRIMARY KEY ("month")
);
