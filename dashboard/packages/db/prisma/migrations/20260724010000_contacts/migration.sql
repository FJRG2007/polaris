-- Saved contacts for starting outbound conversations from the Inbox. Per owner,
-- bound to a platform + platform-side peer id. owner is a bare uuid (no FK).
CREATE TABLE "Contact" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Contact_ownerId_platform_peerId_key" ON "Contact"("ownerId", "platform", "peerId");

CREATE INDEX "Contact_ownerId_idx" ON "Contact"("ownerId");
