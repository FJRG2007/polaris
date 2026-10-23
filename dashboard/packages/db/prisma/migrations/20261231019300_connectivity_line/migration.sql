-- The connectivity sampler's minutes, their hourly sums, and the public address's
-- changes. Additive: three new tables, nothing existing is touched.
-- CreateTable
CREATE TABLE IF NOT EXISTS "ConnectivitySample" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "up" BOOLEAN NOT NULL,
    "dnsOk" BOOLEAN NOT NULL,
    "latencyMs" DOUBLE PRECISION,
    "lossPct" DOUBLE PRECISION NOT NULL,
    "dnsMs" DOUBLE PRECISION,
    "publicIp" TEXT,
    "outsideOk" BOOLEAN,

    CONSTRAINT "ConnectivitySample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConnectivityHour" (
    "bucket" TIMESTAMP(3) NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "upSamples" INTEGER NOT NULL DEFAULT 0,
    "dnsFailSamples" INTEGER NOT NULL DEFAULT 0,
    "latencySum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyCount" INTEGER NOT NULL DEFAULT 0,
    "latencyMax" DOUBLE PRECISION,
    "lossSum" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "ConnectivityHour_pkey" PRIMARY KEY ("bucket")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PublicIpChange" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "previous" TEXT,
    "current" TEXT NOT NULL,

    CONSTRAINT "PublicIpChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConnectivitySample_at_idx" ON "ConnectivitySample"("at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublicIpChange_at_idx" ON "PublicIpChange"("at");
