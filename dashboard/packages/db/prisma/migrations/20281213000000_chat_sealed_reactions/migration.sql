-- Sealed reactions.
--
-- In a sealed conversation the emoji a person has on a message are sealed in
-- their browser, so the server keeps one opaque row per person and message and
-- never learns which emoji; the counts are made in each member's browser.
-- Additive: the plain reaction rows are untouched here (the migrator seals the
-- ones in sealed conversations, keeping a 30-day copy for a rollback), and
-- dropping this table reverses it.

CREATE TABLE IF NOT EXISTS "ChatSealedReaction" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "sealed" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSealedReaction_pkey" PRIMARY KEY ("messageId", "userId")
);

CREATE INDEX IF NOT EXISTS "ChatSealedReaction_userId_idx" ON "ChatSealedReaction"("userId");

DO $$ BEGIN
    ALTER TABLE "ChatSealedReaction" ADD CONSTRAINT "ChatSealedReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ChatSealedReaction" ADD CONSTRAINT "ChatSealedReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
