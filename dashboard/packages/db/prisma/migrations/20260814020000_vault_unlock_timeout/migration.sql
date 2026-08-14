-- How long a browser may keep this vault open while it is idle, in minutes.
-- 0 locks it as soon as its owner leaves the vault; -1 keeps it until the tab
-- closes. Existing vaults get 15, which is what the clients default to.
ALTER TABLE "VaultAccount" ADD COLUMN     "unlockTimeout" INTEGER NOT NULL DEFAULT 15;
