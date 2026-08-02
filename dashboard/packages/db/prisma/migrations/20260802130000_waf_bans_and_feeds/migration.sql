-- Address intelligence the edge enforces: automatic bans and bulk deny feeds.
--
-- Two tables rather than one because they have opposite shapes. A ban is a single
-- address with its own expiry and its own history, written a few at a time. A feed
-- (the Tor exit list) is a few thousand addresses that are always replaced whole and
-- turn over daily; as rows that would be thousands of writes per refresh to represent
-- one list, so it is stored as one row holding the list.
--
-- Neither is read on the request path. Polaris folds both into a snapshot file the
-- edge guard holds in memory, so enforcing a ban costs a map lookup and survives the
-- control plane being down.
CREATE TABLE "WafBan" (
    "id" UUID NOT NULL,
    "ip" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "until" TIMESTAMP(3),
    "offences" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WafBan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WafBan_ip_key" ON "WafBan"("ip");

CREATE INDEX "WafBan_until_idx" ON "WafBan"("until");

CREATE TABLE "WafIpFeed" (
    "id" TEXT NOT NULL,
    "entries" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3),
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WafIpFeed_pkey" PRIMARY KEY ("id")
);
