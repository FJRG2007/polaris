-- Database connections choose how their certificate is checked (libpq's
-- sslmode names), what it is checked against (public authorities, an uploaded
-- one, or the server's own certificate trusted on first use) and may present a
-- client certificate. The stored SSH key's type and fingerprint are kept beside
-- it so the form can say which key is saved without decrypting it.
--
-- Existing rows keep the `tls` flag they have and no mode: the code reads that
-- as "require" (encrypted, not verified), which is what the switch meant.
--
-- Written so that running it a second time is a no-op.

ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "tlsMode" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "tlsTrust" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "tlsCaCert" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "tlsClientCert" TEXT;
ALTER TABLE "DataConnection" ADD COLUMN IF NOT EXISTS "sshKeySummary" TEXT;
