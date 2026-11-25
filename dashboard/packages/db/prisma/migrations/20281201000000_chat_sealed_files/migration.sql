-- Chat files sealed in the sender's browser (docs/chat-e2ee-proposal.md 10b). Additive.
ALTER TABLE "ChatAttachment" ADD COLUMN "sealed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatUpload" ADD COLUMN "sealed" BOOLEAN NOT NULL DEFAULT false;
