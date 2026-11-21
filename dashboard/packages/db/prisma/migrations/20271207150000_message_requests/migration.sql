-- Who may start a conversation with an account (privacy field `messages`,
-- ledger row 17). Null is "never chose", which resolves to the administrator's
-- default and then to everybody - what every account had before.
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "messages" TEXT;

-- A one-to-one held as a message request for this member until they accept it.
ALTER TABLE "ChatChannelMember" ADD COLUMN IF NOT EXISTS "requestedAt" TIMESTAMP(3);

-- The requests inbox reads one member's pending rows, newest first.
CREATE INDEX IF NOT EXISTS "ChatChannelMember_userId_requestedAt_idx"
    ON "ChatChannelMember" ("userId", "requestedAt");
