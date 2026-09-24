-- A player tied to a Polaris account for who they are, without handing their
-- addresses over to the account's sign-ins. Every link made before this followed
-- sign-ins, which is what the default keeps them doing.
ALTER TABLE "GamePlayerLink" ADD COLUMN IF NOT EXISTS "followSignIns" BOOLEAN NOT NULL DEFAULT true;
