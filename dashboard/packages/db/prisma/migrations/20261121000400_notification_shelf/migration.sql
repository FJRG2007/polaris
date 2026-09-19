-- Which shelf of the header switch a notification is about: "personal", an
-- organization's id, or null for one about the account itself. Null for every
-- existing row, which keeps each of them on the bell whatever shelf is open.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "shelf" TEXT;
