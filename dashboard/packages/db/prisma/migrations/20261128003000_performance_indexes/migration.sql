-- Indexes for reads that run on a timer or on every page, and were walking more
-- of a table than they return. Nothing here changes a row.
--
-- IF NOT EXISTS throughout, so a database that already has one - built by hand
-- while this was being measured - is not a failed migration.

-- One channel's main conversation or one of its threads, in time order.
CREATE INDEX IF NOT EXISTS "ChatMessage_channelId_parentId_createdAt_idx" ON "ChatMessage"("channelId", "parentId", "createdAt");

-- The freshest session per account, for presence and the Spotify pass.
CREATE INDEX IF NOT EXISTS "SessionState_userId_lastSeenAt_idx" ON "SessionState"("userId", "lastSeenAt");

-- The sweep of expired sign-in codes, by mailbox, category and age.
CREATE INDEX IF NOT EXISTS "MailMessage_accountId_category_receivedAt_idx" ON "MailMessage"("accountId", "category", "receivedAt");

-- The unread counts behind Mail's rail and the app switcher's badge: only the
-- unseen messages, by mailbox and folder, so an inbox's few unread are found
-- without stepping over a junk folder's thousands. Partial, which the schema
-- cannot declare - see the note on MailMessage.
CREATE INDEX IF NOT EXISTS "MailMessage_unseen_accountId_folderId_idx" ON "MailMessage"("accountId", "folderId") WHERE "seen" = false;

-- Whether a service has a deploy on its way, and a service's deploys newest first.
CREATE INDEX IF NOT EXISTS "Deployment_deployableType_deployableId_status_idx" ON "Deployment"("deployableType", "deployableId", "status");
CREATE INDEX IF NOT EXISTS "Deployment_deployableType_deployableId_createdAt_idx" ON "Deployment"("deployableType", "deployableId", "createdAt");
