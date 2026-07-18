-- AlterTable
ALTER TABLE "Share" ADD COLUMN     "allowDownload" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Share" ADD COLUMN     "allowPreview" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Share" ADD COLUMN     "allowedCidrs" TEXT NOT NULL DEFAULT '[]';
