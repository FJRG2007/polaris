-- A chat message an assistant wrote, answering a mention (`agent`, e.g. "polar").
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "agent" TEXT;
