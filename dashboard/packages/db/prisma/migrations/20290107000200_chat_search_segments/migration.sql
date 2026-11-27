-- Shared search segments for sealed chat (docs/chat-e2ee-mls.md, "Shared
-- search segments"): sealed on a member's device, never read by the server.
--
-- Additive: two new tables, nothing existing changes, and dropping them
-- reverses it (a browser then searches only what it opened, as before).

CREATE TABLE IF NOT EXISTS "ChatSearchSegment" (
    "channelId" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "base" BOOLEAN NOT NULL,
    "messages" INTEGER NOT NULL,
    "lastId" UUID,
    "nonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "builder" TEXT NOT NULL,
    "signature" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSearchSegment_pkey" PRIMARY KEY ("channelId", "epoch", "seq", "generation")
);

CREATE INDEX IF NOT EXISTS "ChatSearchSegment_channelId_createdAt_idx" ON "ChatSearchSegment"("channelId", "createdAt");

CREATE TABLE IF NOT EXISTS "ChatSearchLease" (
    "channelId" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "holder" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSearchLease_pkey" PRIMARY KEY ("channelId", "epoch", "seq")
);

DO $$ BEGIN
    ALTER TABLE "ChatSearchSegment" ADD CONSTRAINT "ChatSearchSegment_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatSearchLease" ADD CONSTRAINT "ChatSearchLease_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
