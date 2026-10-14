-- Who may read somebody's profile. Every existing row starts on "everyone",
-- which is what every account had before the setting existed, so nothing
-- changes until somebody chooses. To reverse, drop the column.

ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "profile" TEXT NOT NULL DEFAULT 'everyone';
