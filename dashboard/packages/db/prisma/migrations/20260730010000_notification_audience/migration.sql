-- Who a notification went to, and whether it is waiting on the recipient. The
-- audience is stored on the row because it is a property of the event that
-- produced it, not something the reader can derive: the same alert fanned out to
-- every administrator must read as "Admins" even when only one account is left.
ALTER TABLE "Notification" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'you';
ALTER TABLE "Notification" ADD COLUMN "audienceLabel" TEXT;
ALTER TABLE "Notification" ADD COLUMN "actionRequired" BOOLEAN NOT NULL DEFAULT false;
