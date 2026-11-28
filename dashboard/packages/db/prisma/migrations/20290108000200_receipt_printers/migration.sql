-- Receipt and kitchen printers, and their print jobs (lib/receipt-print).
--
-- Additive: two new tables. Dropping them reverses it.

CREATE TABLE IF NOT EXISTS "ReceiptPrinter" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'lan',
    "address" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL DEFAULT 9100,
    "paper" TEXT NOT NULL DEFAULT '80',
    "columns" INTEGER,
    "codepage" TEXT NOT NULL DEFAULT 'cp858',
    "codepageNumber" INTEGER,
    "impact" BOOLEAN NOT NULL DEFAULT false,
    "role" TEXT NOT NULL DEFAULT 'receipt',
    "problem" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceiptPrinter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReceiptPrintJob" (
    "id" UUID NOT NULL,
    "printerId" UUID NOT NULL,
    "jobKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "payload" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "problem" TEXT,
    "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printedAt" TIMESTAMP(3),
    CONSTRAINT "ReceiptPrintJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptPrintJob_printerId_jobKey_key" ON "ReceiptPrintJob"("printerId", "jobKey");
CREATE INDEX IF NOT EXISTS "ReceiptPrintJob_printerId_state_nextAt_idx" ON "ReceiptPrintJob"("printerId", "state", "nextAt");
CREATE INDEX IF NOT EXISTS "ReceiptPrintJob_createdAt_idx" ON "ReceiptPrintJob"("createdAt");

ALTER TABLE "ReceiptPrintJob" DROP CONSTRAINT IF EXISTS "ReceiptPrintJob_printerId_fkey";
ALTER TABLE "ReceiptPrintJob" ADD CONSTRAINT "ReceiptPrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "ReceiptPrinter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
