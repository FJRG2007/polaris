-- What somebody last searched for, kept per account so the panel opens on the
-- same list in another browser. Capped by the service that writes it.
CREATE TABLE "SearchHistory" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT,
    "term" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL,
    "href" TEXT,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SearchHistory_userId_key_key" ON "SearchHistory"("userId", "key");

CREATE INDEX "SearchHistory_userId_usedAt_idx" ON "SearchHistory"("userId", "usedAt");

ALTER TABLE "SearchHistory" ADD CONSTRAINT "SearchHistory_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
