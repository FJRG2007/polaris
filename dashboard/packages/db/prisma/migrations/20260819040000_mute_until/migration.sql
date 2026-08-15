-- A silence that ends by itself.
--
-- `muted` already said whether a conversation is quiet; this says until when.
-- Null with `muted` set is "until I turn it back on", which is why the column is
-- nullable rather than defaulted to a far-off date: those are two different
-- states and the screen has to be able to say which one somebody chose.
--
-- Every existing row keeps whatever it had. A conversation muted before this
-- migration stays muted with no end, which is what it was.

-- AlterTable
ALTER TABLE "ChatChannelMember" ADD COLUMN     "mutedUntil" TIMESTAMP(3);
