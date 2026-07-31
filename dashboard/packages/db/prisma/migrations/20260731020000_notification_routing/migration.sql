-- Per-account routing for alerts: which events are wanted, and where they go.
-- The rules are stringified JSON keyed by event id; events absent from it follow
-- the catalogue default, so adding an event later needs no migration.
ALTER TABLE "User" ADD COLUMN "notifyPrefs" TEXT;

-- Somewhere an alert can go besides the bell and the account's mailbox. The
-- target is envelope-encrypted because a webhook URL is itself the credential;
-- "targetHint" is the masked form the UI lists, so reading the list never needs
-- the master key.
CREATE TABLE "NotificationDestination" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT,
    "targetHint" TEXT NOT NULL,
    "encryptedTarget" BYTEA NOT NULL,
    "targetNonce" BYTEA NOT NULL,
    "targetKeyId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "lastError" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDestination_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationDestination_userId_idx" ON "NotificationDestination"("userId");
ALTER TABLE "NotificationDestination" ADD CONSTRAINT "NotificationDestination_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One attempt to get one event to one place, so the history can answer whether
-- an alert actually arrived rather than only that it was raised.
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "destinationId" UUID,
    "destinationHint" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationDelivery_userId_createdAt_idx" ON "NotificationDelivery"("userId", "createdAt");
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
