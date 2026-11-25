-- A sealed file a reporter opened for the moderators: its own key and digest (docs/chat-e2ee-mls.md, "Sealed reports"). Additive.
ALTER TABLE "ChatReportFile" ADD COLUMN IF NOT EXISTS "sealedKey" BYTEA;
ALTER TABLE "ChatReportFile" ADD COLUMN IF NOT EXISTS "sealedDigest" BYTEA;
