-- Which automation a Watch alarm was carried into, once the boot step that moves
-- alarms to Automations has published its twin. Null while the alarm is still
-- Watch's own. A new nullable column and its index only; nothing existing
-- changes, and both statements are no-ops when run a second time.
ALTER TABLE "Alarm" ADD COLUMN IF NOT EXISTS "carriedToId" UUID;

CREATE INDEX IF NOT EXISTS "Alarm_carriedToId_idx" ON "Alarm"("carriedToId");
