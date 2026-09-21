-- A file shared out of a Drive rather than copied into the conversation.
-- Polaris never deletes one, the size ceiling does not apply to it, and it can
-- change or vanish under the message that points at it.
ALTER TABLE "ChatAttachment" ADD COLUMN IF NOT EXISTS "borrowed" BOOLEAN NOT NULL DEFAULT false;
