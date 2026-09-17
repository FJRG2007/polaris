-- Database connections reached through an SSH tunnel: through a registered
-- server, or through an SSH login the connection holds (optionally behind a
-- registered server as a bastion). Read-only stops being the default for a new
-- connection; existing rows keep the value they have.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshMode" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshHostId" UUID;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshHost" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshPort" INTEGER;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshUsername" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshAuthMethod" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshEncryptedCredential" BYTEA;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshCredentialNonce" BYTEA;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshCredentialKeyId" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshHostKey" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshJumpHostId" UUID;
ALTER TABLE "DataConnection" ALTER COLUMN "readOnly" SET DEFAULT false;

CREATE INDEX IF NOT EXISTS "DataConnection_sshHostId_idx" ON "DataConnection"("sshHostId");
CREATE INDEX IF NOT EXISTS "DataConnection_sshJumpHostId_idx" ON "DataConnection"("sshJumpHostId");

ALTER TABLE "DataConnection" DROP CONSTRAINT IF EXISTS "DataConnection_sshHostId_fkey";
ALTER TABLE "DataConnection" ADD CONSTRAINT "DataConnection_sshHostId_fkey" FOREIGN KEY ("sshHostId") REFERENCES "Host"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DataConnection" DROP CONSTRAINT IF EXISTS "DataConnection_sshJumpHostId_fkey";
ALTER TABLE "DataConnection" ADD CONSTRAINT "DataConnection_sshJumpHostId_fkey" FOREIGN KEY ("sshJumpHostId") REFERENCES "Host"("id") ON DELETE SET NULL ON UPDATE CASCADE;
