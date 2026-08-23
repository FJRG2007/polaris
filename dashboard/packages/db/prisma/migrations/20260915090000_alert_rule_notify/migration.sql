-- Whether an alert also reaches the bell.
--
-- Every sighting is written down in Places whether or not anybody asked to be
-- told, and until now every one of them also wrote a notification. A camera
-- watching a room somebody works in reports them all day, so the bell filled
-- with "somebody is at the studio" and the four entries that mattered went
-- under it.
--
-- So an alert stays what it was - a message in a conversation - and reaching
-- the bell is something a rule is asked for. Off for the ones that already
-- exist: they were written when nobody was offered the choice.

-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN     "notify" BOOLEAN NOT NULL DEFAULT false;
