-- The three tables the retention sweep walks by age, and by nothing else.
--
-- Each of them already has an index that leads with a different column - a user,
-- a subject, an address hash - so a query that only knows "older than this date"
-- was scanning the whole table, on a schedule, on the three tables that grow
-- fastest.
--
-- Written to be safe to run twice: the entrypoint retries migrations, and an
-- update can kill the container part-way through one.
CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX IF NOT EXISTS "Activity_createdAt_idx" ON "Activity"("createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_at_idx" ON "AuditLog"("at");
