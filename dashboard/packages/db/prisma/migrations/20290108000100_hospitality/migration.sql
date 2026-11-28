-- Hospitality (apps/hospitality): the menu, the floor, orders and their lines,
-- payments, till shifts and cash movements, numbering series, venues, their staff and price overrides.
-- The hospitality.* permissions need no row: admin holds them through its
-- wildcard, and staff are given them under Management > Users.
--
-- Additive only, and running it a second time is a no-op. To reverse, drop
-- the thirteen "Hospitality*" tables.

CREATE TABLE IF NOT EXISTS "HospitalityCategory" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "icon" TEXT NOT NULL DEFAULT 'utensils',
    "imageUrl" TEXT,
    "station" TEXT NOT NULL DEFAULT 'kitchen',
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityProduct" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price" INTEGER NOT NULL,
    "taxRateBp" INTEGER NOT NULL DEFAULT 1000,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageUrl" TEXT,
    "sku" TEXT,
    "station" TEXT,
    "modifiers" JSONB,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalityProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityRoom" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityRoom_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityTable" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "width" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "height" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "shape" TEXT NOT NULL DEFAULT 'square',
    "seats" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityTable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityOrder" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "tableId" UUID,
    "label" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "covers" INTEGER NOT NULL DEFAULT 0,
    "waiterId" UUID,
    "waiterName" TEXT NOT NULL DEFAULT '',
    "staffId" UUID,
    "discount" JSONB,
    "note" TEXT NOT NULL DEFAULT '',
    "ticketNo" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "shiftId" UUID,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalityOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityOrderLine" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID,
    "name" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "taxRateBp" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "modifiers" JSONB,
    "note" TEXT NOT NULL DEFAULT '',
    "course" INTEGER NOT NULL DEFAULT 0,
    "station" TEXT NOT NULL DEFAULT 'kitchen',
    "discount" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "byName" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityPayment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shiftId" UUID,
    "method" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "tip" INTEGER NOT NULL DEFAULT 0,
    "tendered" INTEGER NOT NULL DEFAULT 0,
    "lineIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "byId" UUID,
    "byName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityShift" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "openedById" UUID,
    "openedByName" TEXT NOT NULL DEFAULT '',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "float" INTEGER NOT NULL DEFAULT 0,
    "closedById" UUID,
    "closedByName" TEXT NOT NULL DEFAULT '',
    "closedAt" TIMESTAMP(3),
    "counted" INTEGER,
    "expected" INTEGER,
    "zNumber" INTEGER,

    CONSTRAINT "HospitalityShift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityCashMove" (
    "id" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "byId" UUID,
    "byName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityCashMove_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityCounter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HospitalityCounter_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "HospitalityVenue" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "businessName" TEXT NOT NULL DEFAULT '',
    "taxId" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "footer" TEXT NOT NULL DEFAULT '',
    "ticketPrefix" TEXT NOT NULL DEFAULT 'T',
    "staffMode" TEXT NOT NULL DEFAULT 'none',
    "printers" JSONB,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalityVenue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HospitalityPriceOverride" (
    "venueId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "price" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalityPriceOverride_pkey" PRIMARY KEY ("venueId","productId")
);

CREATE TABLE IF NOT EXISTS "HospitalityStaff" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'sky',
    "imageUrl" TEXT,
    "role" TEXT NOT NULL DEFAULT 'waiter',
    "pinHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityStaff_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "HospitalityCategory_position_idx" ON "HospitalityCategory"("position");

CREATE INDEX IF NOT EXISTS "HospitalityProduct_categoryId_position_idx" ON "HospitalityProduct"("categoryId", "position");

CREATE INDEX IF NOT EXISTS "HospitalityProduct_sku_idx" ON "HospitalityProduct"("sku");

CREATE INDEX IF NOT EXISTS "HospitalityRoom_venueId_position_idx" ON "HospitalityRoom"("venueId", "position");

CREATE INDEX IF NOT EXISTS "HospitalityTable_roomId_idx" ON "HospitalityTable"("roomId");

CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityOrder_ticketNo_key" ON "HospitalityOrder"("ticketNo");

CREATE INDEX IF NOT EXISTS "HospitalityOrder_venueId_status_openedAt_idx" ON "HospitalityOrder"("venueId", "status", "openedAt");

CREATE INDEX IF NOT EXISTS "HospitalityOrder_tableId_status_idx" ON "HospitalityOrder"("tableId", "status");

CREATE INDEX IF NOT EXISTS "HospitalityOrder_shiftId_idx" ON "HospitalityOrder"("shiftId");

CREATE INDEX IF NOT EXISTS "HospitalityOrderLine_orderId_idx" ON "HospitalityOrderLine"("orderId");

CREATE INDEX IF NOT EXISTS "HospitalityOrderLine_status_station_sentAt_idx" ON "HospitalityOrderLine"("status", "station", "sentAt");

CREATE INDEX IF NOT EXISTS "HospitalityPayment_orderId_idx" ON "HospitalityPayment"("orderId");

CREATE INDEX IF NOT EXISTS "HospitalityPayment_shiftId_method_idx" ON "HospitalityPayment"("shiftId", "method");

CREATE INDEX IF NOT EXISTS "HospitalityShift_venueId_closedAt_idx" ON "HospitalityShift"("venueId", "closedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityShift_venueId_zNumber_key" ON "HospitalityShift"("venueId", "zNumber");

CREATE INDEX IF NOT EXISTS "HospitalityCashMove_shiftId_idx" ON "HospitalityCashMove"("shiftId");

CREATE INDEX IF NOT EXISTS "HospitalityPriceOverride_productId_idx" ON "HospitalityPriceOverride"("productId");

CREATE INDEX IF NOT EXISTS "HospitalityStaff_venueId_active_idx" ON "HospitalityStaff"("venueId", "active");

DO $$ BEGIN
    ALTER TABLE "HospitalityProduct" ADD CONSTRAINT "HospitalityProduct_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "HospitalityCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "HospitalityRoom" ADD CONSTRAINT "HospitalityRoom_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "HospitalityVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "HospitalityTable" ADD CONSTRAINT "HospitalityTable_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HospitalityRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "HospitalityOrderLine" ADD CONSTRAINT "HospitalityOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "HospitalityOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "HospitalityPayment" ADD CONSTRAINT "HospitalityPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "HospitalityOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "HospitalityCashMove" ADD CONSTRAINT "HospitalityCashMove_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "HospitalityShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "HospitalityPriceOverride" ADD CONSTRAINT "HospitalityPriceOverride_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "HospitalityVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "HospitalityStaff" ADD CONSTRAINT "HospitalityStaff_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "HospitalityVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Devices linked to a venue by QR + code, and links being made.
CREATE TABLE IF NOT EXISTS "HospitalityDevice" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityDevice_tokenHash_key" ON "HospitalityDevice"("tokenHash");
CREATE INDEX IF NOT EXISTS "HospitalityDevice_venueId_revokedAt_idx" ON "HospitalityDevice"("venueId", "revokedAt");
DO $$ BEGIN
    ALTER TABLE "HospitalityDevice" ADD CONSTRAINT "HospitalityDevice_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "HospitalityVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "HospitalityDeviceLink" (
    "id" UUID NOT NULL,
    "userCode" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "venueId" UUID,
    "name" TEXT NOT NULL DEFAULT '',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "deviceId" UUID,
    "lastPolledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityDeviceLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityDeviceLink_userCode_key" ON "HospitalityDeviceLink"("userCode");
CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityDeviceLink_deviceCodeHash_key" ON "HospitalityDeviceLink"("deviceCodeHash");
CREATE INDEX IF NOT EXISTS "HospitalityDeviceLink_expiresAt_idx" ON "HospitalityDeviceLink"("expiresAt");
