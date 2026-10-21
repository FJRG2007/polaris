-- The speech-to-text model Polar's dictation and voice mode hear with, picked
-- from the mic menu. Null is the fastest model a key is held for.
ALTER TABLE "PolarPreference" ADD COLUMN IF NOT EXISTS "transcriptionModel" TEXT;

-- How long a transcription was, so the audio Polar sends to a provider is
-- counted next to the tokens its answers spend. 0 for a chat answer.
ALTER TABLE "PolarUsage" ADD COLUMN IF NOT EXISTS "audioSeconds" INTEGER NOT NULL DEFAULT 0;
