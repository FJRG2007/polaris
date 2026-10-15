-- Private addresses: who may open one deployed domain, as JSON. Additive and
-- nullable, so every existing domain stays public. To reverse, drop the column.

ALTER TABLE "Domain" ADD COLUMN IF NOT EXISTS "privateAccess" TEXT;
