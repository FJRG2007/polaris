-- Per-order version, so two devices on one table never overwrite each other.
ALTER TABLE "HospitalityOrder" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HospitalityOrder" ADD COLUMN IF NOT EXISTS "updatedByName" TEXT NOT NULL DEFAULT '';

-- One open till per venue (or per area with a till of its own), even when two start at once.
CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityShift_one_open_key"
    ON "HospitalityShift"("venueId", COALESCE("areaId", '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE "closedAt" IS NULL;

-- One live order per table, even when two waiters open the same table at once.
-- An install that already holds two live orders on one table keeps working
-- without it (the code still answers the order already open) rather than
-- failing the migration.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "HospitalityOrder" WHERE "tableId" IS NOT NULL AND "status" IN ('open', 'billed')
        GROUP BY "tableId" HAVING COUNT(*) > 1
    ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS "HospitalityOrder_one_live_per_table_key" ON "HospitalityOrder"("tableId")
            WHERE "tableId" IS NOT NULL AND "status" IN ('open', 'billed');
    END IF;
END $$;

-- The audit trail: every change to an order, a payment or the till.
CREATE TABLE IF NOT EXISTS "HospitalityAuditEvent" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "orderId" UUID,
    "shiftId" UUID,
    "subjectId" UUID,
    "kind" TEXT NOT NULL,
    "actorId" UUID,
    "actorName" TEXT NOT NULL DEFAULT '',
    "actorKind" TEXT NOT NULL DEFAULT 'user',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalityAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "HospitalityAuditEvent_venueId_at_idx" ON "HospitalityAuditEvent"("venueId", "at");
CREATE INDEX IF NOT EXISTS "HospitalityAuditEvent_orderId_at_idx" ON "HospitalityAuditEvent"("orderId", "at");
CREATE INDEX IF NOT EXISTS "HospitalityAuditEvent_subjectId_idx" ON "HospitalityAuditEvent"("subjectId");

-- Records the law asks to keep are immutable in the database itself, whatever
-- code reaches them: the audit trail, a closed Z with its payments and cash
-- movements, and the money of a paid order and its lines.
CREATE OR REPLACE FUNCTION hospitality_refuse_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'hospitality: % is a closed record and cannot be changed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "HospitalityAuditEvent_append_only" ON "HospitalityAuditEvent";
CREATE TRIGGER "HospitalityAuditEvent_append_only" BEFORE UPDATE OR DELETE ON "HospitalityAuditEvent"
    FOR EACH ROW EXECUTE FUNCTION hospitality_refuse_change();

DROP TRIGGER IF EXISTS "HospitalityShift_closed" ON "HospitalityShift";
CREATE TRIGGER "HospitalityShift_closed" BEFORE UPDATE OR DELETE ON "HospitalityShift"
    FOR EACH ROW WHEN (OLD."closedAt" IS NOT NULL) EXECUTE FUNCTION hospitality_refuse_change();

CREATE OR REPLACE FUNCTION hospitality_refuse_closed_shift_child() RETURNS trigger AS $$
BEGIN
    IF OLD."shiftId" IS NOT NULL AND EXISTS (SELECT 1 FROM "HospitalityShift" s WHERE s."id" = OLD."shiftId" AND s."closedAt" IS NOT NULL) THEN
        RAISE EXCEPTION 'hospitality: % belongs to a closed Z and cannot be changed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "HospitalityPayment_closed_shift" ON "HospitalityPayment";
CREATE TRIGGER "HospitalityPayment_closed_shift" BEFORE UPDATE OR DELETE ON "HospitalityPayment"
    FOR EACH ROW EXECUTE FUNCTION hospitality_refuse_closed_shift_child();

DROP TRIGGER IF EXISTS "HospitalityCashMove_closed_shift" ON "HospitalityCashMove";
CREATE TRIGGER "HospitalityCashMove_closed_shift" BEFORE UPDATE OR DELETE ON "HospitalityCashMove"
    FOR EACH ROW EXECUTE FUNCTION hospitality_refuse_closed_shift_child();

CREATE OR REPLACE FUNCTION hospitality_refuse_paid_order_change() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."total" IS DISTINCT FROM OLD."total"
        OR NEW."ticketNo" IS DISTINCT FROM OLD."ticketNo" OR NEW."discount"::text IS DISTINCT FROM OLD."discount"::text
        OR NEW."shiftId" IS DISTINCT FROM OLD."shiftId" THEN
        RAISE EXCEPTION 'hospitality: a paid order cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "HospitalityOrder_paid" ON "HospitalityOrder";
CREATE TRIGGER "HospitalityOrder_paid" BEFORE UPDATE OR DELETE ON "HospitalityOrder"
    FOR EACH ROW WHEN (OLD."status" = 'paid') EXECUTE FUNCTION hospitality_refuse_paid_order_change();

CREATE OR REPLACE FUNCTION hospitality_refuse_paid_line_change() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "HospitalityOrder" o WHERE o."id" = OLD."orderId" AND o."status" = 'paid') AND (
        TG_OP = 'DELETE' OR NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
        OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice" OR NEW."taxRateBp" IS DISTINCT FROM OLD."taxRateBp"
        OR NEW."discount"::text IS DISTINCT FROM OLD."discount"::text OR NEW."modifiers"::text IS DISTINCT FROM OLD."modifiers"::text
        OR (NEW."status" = 'void') IS DISTINCT FROM (OLD."status" = 'void')
    ) THEN
        RAISE EXCEPTION 'hospitality: a line of a paid order cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "HospitalityOrderLine_paid" ON "HospitalityOrderLine";
CREATE TRIGGER "HospitalityOrderLine_paid" BEFORE UPDATE OR DELETE ON "HospitalityOrderLine"
    FOR EACH ROW EXECUTE FUNCTION hospitality_refuse_paid_line_change();
