-- Large sealed groups: the ratchet tree kept apart from the GroupInfo.
--
-- Past a size a commit leaves the tree out of its Welcome and GroupInfo
-- (RFC 9420, 12.4.3.3) and the committer uploads it here in parts; a joiner
-- fetches it and checks it against the tree hash the signed GroupInfo commits
-- to. Additive: nothing existing changes, small groups keep the tree inline,
-- and dropping this table reverses it.

CREATE TABLE IF NOT EXISTS "MlsTreePart" (
    "channelId" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "sender" TEXT NOT NULL,
    "part" INTEGER NOT NULL,
    "parts" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "committed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlsTreePart_pkey" PRIMARY KEY ("channelId", "epoch", "sender", "part")
);

CREATE INDEX IF NOT EXISTS "MlsTreePart_channelId_committed_epoch_idx" ON "MlsTreePart"("channelId", "committed", "epoch");

DO $$ BEGIN
    ALTER TABLE "MlsTreePart" ADD CONSTRAINT "MlsTreePart_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "MlsGroup"("channelId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
