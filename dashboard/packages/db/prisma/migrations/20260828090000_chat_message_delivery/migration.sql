-- When a message reached the other person and when they saw it, per message.
--
-- The marks on the membership row are monotonic - they say how far somebody has
-- got now - so they can say whether a message has been read but never when it
-- was. The message information panel needs the moment, so the moment is stamped
-- on the message the first time it happens and never moved afterwards.
--
-- Only written in a one-to-one conversation. Everything already sent keeps NULL:
-- those moments were not recorded, and inventing them would be worse than
-- saying so.

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "deliveredAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN     "readAt" TIMESTAMP(3);
