-- The account key log (key transparency, design 4.6).
--
-- An append-only Merkle tree of every published account key version: the
-- leaves, and the hashes of its complete subtrees. Additive: existing account
-- keys are appended the first time anybody asks for a proof of them, so no row
-- is rewritten here and an install that never opens sealed chat stays empty.

CREATE TABLE IF NOT EXISTS "ChatKeyLogEntry" (
    "index" INTEGER NOT NULL,
    "userId" UUID NOT NULL,
    "akVersion" INTEGER NOT NULL,
    "signPublicKey" BYTEA NOT NULL,
    "hpkePublicKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatKeyLogEntry_pkey" PRIMARY KEY ("index")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChatKeyLogEntry_userId_akVersion_key" ON "ChatKeyLogEntry"("userId", "akVersion");

CREATE TABLE IF NOT EXISTS "ChatKeyLogNode" (
    "level" INTEGER NOT NULL,
    "index" INTEGER NOT NULL,
    "hash" BYTEA NOT NULL,

    CONSTRAINT "ChatKeyLogNode_pkey" PRIMARY KEY ("level", "index")
);
