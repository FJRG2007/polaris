-- What a recording sounds like, so a voice message can say how long it is and
-- draw its own shape without anybody downloading it first.
ALTER TABLE "ChatAttachment" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "ChatAttachment" ADD COLUMN "waveform" TEXT;
