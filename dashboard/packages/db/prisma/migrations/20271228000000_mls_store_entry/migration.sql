-- The OpenMLS storage of the MLS members the server runs (Polar, webhook and
-- automation service members): one row per key, the value sealed under
-- POLARIS_MASTER_KEY.
--
-- Additive, and a no-op when run again.
-- To reverse: DROP TABLE "MlsStoreEntry";
CREATE TABLE IF NOT EXISTS "MlsStoreEntry" (
    "device" TEXT NOT NULL,
    "key" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "keyId" TEXT NOT NULL,

    CONSTRAINT "MlsStoreEntry_pkey" PRIMARY KEY ("device","key")
);
