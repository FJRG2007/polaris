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

-- Every key the log has signed heads with, in order: the first with no
-- "fromKey", each later one with the head at the change and the previous key's
-- signature over both - or no signature when the previous key could no longer
-- be read (the master key changed), which browsers show as a reset.
CREATE TABLE IF NOT EXISTS "ChatKeyLogHandover" (
    "id" UUID NOT NULL,
    "fromKey" BYTEA,
    "toKey" BYTEA NOT NULL,
    "treeSize" INTEGER NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "rootHash" BYTEA NOT NULL,
    "signature" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatKeyLogHandover_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChatKeyLogHandover_toKey_key" ON "ChatKeyLogHandover"("toKey");
