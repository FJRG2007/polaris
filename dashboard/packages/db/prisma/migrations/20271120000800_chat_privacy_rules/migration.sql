-- Read receipts and the typing indicator as a conversation's own rule, beside
-- its disappearing-messages timer. "follow" is every existing conversation:
-- each person's account setting keeps deciding until somebody changes it.
--
-- Additive and rerunnable. To undo: drop the four columns.

ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "receipts" TEXT NOT NULL DEFAULT 'follow';
ALTER TABLE "ChatChannel" ADD COLUMN IF NOT EXISTS "typing" TEXT NOT NULL DEFAULT 'follow';
ALTER TABLE "ChatRuleProposal" ADD COLUMN IF NOT EXISTS "receipts" TEXT NOT NULL DEFAULT 'follow';
ALTER TABLE "ChatRuleProposal" ADD COLUMN IF NOT EXISTS "typing" TEXT NOT NULL DEFAULT 'follow';
