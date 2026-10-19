-- A vault passkey is one of the account's sign-in passkeys turned on, so its
-- name and its address are read from that `Passkey` row instead of being kept
-- twice. Both copies go. The table held no rows when this shipped, and nothing
-- reads either column any more, so dropping them loses nothing.
--
-- Every statement is written so that running it a second time is a no-op.

-- AlterTable
ALTER TABLE "VaultPasskey" DROP COLUMN IF EXISTS "name";
ALTER TABLE "VaultPasskey" DROP COLUMN IF EXISTS "rpId";
