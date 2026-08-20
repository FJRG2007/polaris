-- A still from a video, taken by the browser that sent it.
--
-- Kept rather than made on demand: the alternative is every reader fetching the
-- head of every video in a room to draw one frame, which is the thing a
-- thumbnail exists to avoid. A few kilobytes against a file measured in
-- megabytes, and the difference between a list of black rectangles and a list
-- somebody can read.
--
-- Null everywhere it does not apply, which is every attachment that already
-- exists and every one that is not a video.
ALTER TABLE "ChatAttachment" ADD COLUMN "posterPath" TEXT;
ALTER TABLE "ChatAttachment" ADD COLUMN "posterConnectionId" UUID;

-- The same two on a file waiting to be sent, so a message scheduled with a video
-- arrives with the thumbnail it would have had.
ALTER TABLE "ChatScheduledFile" ADD COLUMN "posterPath" TEXT;
ALTER TABLE "ChatScheduledFile" ADD COLUMN "posterConnectionId" UUID;
