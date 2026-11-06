-- The furthest each member has ever read, kept apart from the read mark so
-- marking a conversation unread does not take back its read ticks. Additive:
-- existing rows stay null and fall back to "lastReadAt".
ALTER TABLE "ChatChannelMember" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);
