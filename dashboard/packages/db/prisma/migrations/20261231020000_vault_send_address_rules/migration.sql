-- A Send takes the address rules every public link in Polaris offers. They are
-- Polaris's own: the Send protocol has no field for them, so a Bitwarden client
-- never sends them and its updates leave them as they are. An empty list is no
-- restriction, so every existing Send keeps opening. Reversible: drop the three
-- columns.
ALTER TABLE "VaultSend" ADD COLUMN IF NOT EXISTS "allowedCidrs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "VaultSend" ADD COLUMN IF NOT EXISTS "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "VaultSend" ADD COLUMN IF NOT EXISTS "allowedContinents" TEXT NOT NULL DEFAULT '[]';
