-- NAS-backed deploy volumes: link a bind volume to a storage connection so its
-- source resolves under that connection's host mount (never an arbitrary path).
ALTER TABLE "Volume" ADD COLUMN "connectionId" UUID;

CREATE INDEX "Volume_connectionId_idx" ON "Volume"("connectionId");

ALTER TABLE "Volume" ADD CONSTRAINT "Volume_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StorageConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
