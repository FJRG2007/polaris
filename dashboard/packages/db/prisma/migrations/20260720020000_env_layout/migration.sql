-- Add the canvas layout (positions + links) to environments.
ALTER TABLE "Environment" ADD COLUMN "layout" TEXT NOT NULL DEFAULT '{}';
