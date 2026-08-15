-- A conversation somebody keeps at the top of their own list. Per membership,
-- so it is one person's ordering and says nothing to anybody else in the room.
-- The time rather than a flag, so several pinned conversations keep the order
-- they were pinned in.
ALTER TABLE "ChatChannelMember" ADD COLUMN "pinnedAt" TIMESTAMP(3);
