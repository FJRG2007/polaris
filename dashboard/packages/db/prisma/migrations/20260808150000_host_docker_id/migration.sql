-- Which Docker daemon a registered server turned out to be running. A server
-- reached over SSH can be the same machine Polaris itself runs on, and one box
-- reporting twice reads as two servers that disagree about their own load.
ALTER TABLE "Host" ADD COLUMN "dockerId" TEXT;
