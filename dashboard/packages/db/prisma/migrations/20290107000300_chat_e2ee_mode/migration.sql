-- The end-to-end encryption mode last applied to a conversation from its join
-- rule (docs/chat-e2ee-mls.md, "Encryption policy"). Additive and nullable:
-- null is "not decided yet", which the dashboard's sweep fills.
ALTER TABLE "ChatChannel" ADD COLUMN "e2eeMode" TEXT;
