-- Web Push subscriptions and remote answers to an agent's permission prompts:
-- two new tables, nothing existing is touched.
--
-- Every statement is written so that running it a second time is a no-op.
-- To reverse: DROP TABLE "AgentPermissionRequest"; DROP TABLE "PushSubscription";
CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId");
ALTER TABLE "PushSubscription" DROP CONSTRAINT IF EXISTS "PushSubscription_userId_fkey";
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AgentPermissionRequest" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "suggestions" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answeredById" UUID,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentPermissionRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentPermissionRequest_sessionId_status_idx" ON "AgentPermissionRequest"("sessionId", "status");
ALTER TABLE "AgentPermissionRequest" DROP CONSTRAINT IF EXISTS "AgentPermissionRequest_sessionId_fkey";
ALTER TABLE "AgentPermissionRequest" ADD CONSTRAINT "AgentPermissionRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
