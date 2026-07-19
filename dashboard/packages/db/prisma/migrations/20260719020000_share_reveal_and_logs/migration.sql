-- AlterTable
ALTER TABLE "Share" ADD COLUMN     "encryptedToken" BYTEA;
ALTER TABLE "Share" ADD COLUMN     "tokenNonce" BYTEA;
ALTER TABLE "Share" ADD COLUMN     "tokenKeyId" TEXT;

-- AlterTable
ALTER TABLE "ShareAccessLog" ADD COLUMN     "ip" TEXT;
