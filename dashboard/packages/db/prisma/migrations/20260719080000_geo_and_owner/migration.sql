-- AlterTable
ALTER TABLE "Share" ADD COLUMN "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Share" ADD COLUMN "allowedContinents" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "FileRequest" ADD COLUMN "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "FileRequest" ADD COLUMN "allowedContinents" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "DriveItemMeta" ADD COLUMN "creatorId" TEXT;

-- CreateTable
CREATE TABLE "GeoIpCache" (
    "ip" TEXT NOT NULL,
    "countryCode" TEXT,
    "country" TEXT,
    "continent" TEXT,
    "source" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoIpCache_pkey" PRIMARY KEY ("ip")
);
