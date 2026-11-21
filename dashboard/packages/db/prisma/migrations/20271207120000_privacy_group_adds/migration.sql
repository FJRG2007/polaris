-- Who may add an account to a group conversation (privacy field `groupAdds`).
-- Nullable: null resolves to the code default, the rule every account had
-- before, so existing accounts are unchanged and nothing needs a backfill.
ALTER TABLE "UserPrivacy" ADD COLUMN IF NOT EXISTS "groupAdds" TEXT;
